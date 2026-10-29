// SPDX-License-Identifier: MPL-2.0
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { BrokerApi, DraftChannel, DraftDestination, DraftIntent, ImportedFile, ServerState } from "../api.ts";
import { destinationWidget, DESTINATION_WIDGET_KEY } from "./destination-widget.ts";
import { INBOX_REMINDER } from "../inbox-guidance.ts";
import { BridgeError } from "../protocol.ts";
import { isImageAttachment } from "../transfers/policy.ts";

export interface DraftContext extends Pick<ExtensionContext, "mode" | "hasUI" | "agent"> {
	readonly sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId">;
	readonly ui: Pick<ExtensionContext["ui"], "setWidget" | "supportsEditor" | "setEditorText" | "getEditorText" | "pasteToEditor" | "notify">;
}

export interface DraftIdentity {
	readonly sessionId: string;
	readonly token: string;
}

/** Owns one actual OMP composer's lifetime, independently of execution-device selection. */
export class DraftBridge {
	#identity: DraftIdentity;
	#channel: DraftChannel | undefined;
	#destination: DraftDestination | undefined;
	#closed = false;
	#pending = new Map<string, Promise<void>>();

	constructor(
		private readonly broker: Pick<BrokerApi, "openDraft" | "claimIntent" | "finishIntent">,
		private readonly ctx: DraftContext,
		private readonly onState: (state: ServerState) => void,
	) {
		this.#identity = { sessionId: ctx.sessionManager.getSessionId(), token: crypto.randomUUID() };
		if (ctx.mode === "tui" && ctx.hasUI && ctx.agent.kind === "main" && ctx.ui.supportsEditor) {
			this.#channel = broker.openDraft(this.#identity.sessionId, this.#identity.token, {
				onDestination: destination => this.#publish(destination),
				onIntent: intent => this.#receive(intent),
				onError: () => {
					this.#publish(undefined);
					if (!this.#closed) ctx.ui.notify("Client bridge: draft connection unavailable; waiting for a new destination", "error");
				},
			});
		}
	}

	get identity(): DraftIdentity {
		return this.#identity;
	}

	/** Called on submitted interactive input, never on editor change/keystroke. */
	submitted(): void {
		if (this.#closed || !this.#channel) return;
		if (this.ctx.sessionManager.getSessionId() !== this.#identity.sessionId) {
			this.close();
			return;
		}
		this.#identity = { sessionId: this.#identity.sessionId, token: crypto.randomUUID() };
		this.#publish(undefined);
		this.#channel.update(this.#identity.token);
	}

	#publish(destination: DraftDestination | undefined): void {
		if (this.#closed) return;
		const previous = this.#destination;
		// The broker acknowledges the current token before it becomes discoverable.
		// Reconnect/update first clears the lease, invalidating all asynchronous work.
		this.#destination = destination?.draftToken === this.#identity.token
			&& this.ctx.sessionManager.getSessionId() === this.#identity.sessionId ? destination : undefined;
		if (previous === this.#destination) return;
		this.ctx.ui.setWidget(DESTINATION_WIDGET_KEY,
			this.#destination ? destinationWidget(this.#destination.id) : undefined,
			{ placement: "aboveEditor" });
	}

	#receive(intent: DraftIntent): void {
		const identity = this.#identity;
		const destination = this.#destination;
		if (this.#closed || !destination || this.#pending.has(intent.id)
			|| intent.destinationId !== destination.id || intent.sessionId !== identity.sessionId
			|| intent.draftToken !== identity.token || this.ctx.sessionManager.getSessionId() !== identity.sessionId) return;
		const operation = this.#claim(intent.id, identity, destination);
		this.#pending.set(intent.id, operation);
		void operation.finally(() => this.#pending.delete(intent.id));
	}

	#assertCurrent(identity: DraftIdentity, destination: DraftDestination): void {
		if (this.#closed || this.#identity !== identity || this.#destination !== destination
			|| this.ctx.sessionManager.getSessionId() !== identity.sessionId) {
			throw new BridgeError("draft_changed", "The original OMP draft or destination was submitted, replaced, or disconnected; operation was not retargeted");
		}
	}

	async #claim(id: string, identity: DraftIdentity, destination: DraftDestination): Promise<void> {
		let claimed = false;
		try {
			this.#assertCurrent(identity, destination);
			const claim = await this.broker.claimIntent(id, identity.sessionId, identity.token, destination.id);
			claimed = true;
			this.#assertCurrent(identity, destination);
			if (claim.id !== id || claim.state.serverInstance !== destination.serverInstance || claim.state.binding.sessionId !== identity.sessionId) {
				throw new BridgeError("draft_changed", "The claimed operation does not belong to the original OMP destination");
			}
			this.onState(claim.state);
			if (claim.kind === "attach" || claim.kind === "paste") {
				if (!this.ctx.ui.supportsEditor || this.ctx.mode !== "tui") {
					throw new BridgeError("editor_unavailable", "This OMP host does not expose an interactive draft editor");
				}
				if (claim.kind === "attach") {
					if (!claim.files?.length) throw new BridgeError("empty_attachment", "The verified transfer contains no files");
					await this.#attach(claim.files, identity, destination);
				} else {
					if (typeof claim.text !== "string" || typeof this.ctx.ui.pasteToEditor !== "function") {
						throw new BridgeError("paste_unavailable", "This OMP host cannot insert the requested native paste");
					}
					this.#assertCurrent(identity, destination);
					this.ctx.ui.pasteToEditor(claim.text);
				}
			}
			this.#assertCurrent(identity, destination);
			await this.broker.finishIntent(id);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (claimed) {
				try {
					await this.broker.finishIntent(id, message);
				} catch {
					// Never replay a native editor handoff because its receipt was lost.
				}
			}
			if (!this.#closed) this.ctx.ui.notify(`Client bridge: ${message}`, "error");
		}
	}

	async #attach(files: readonly ImportedFile[], identity: DraftIdentity, destination: DraftDestination): Promise<void> {
		// Validate all files before touching the draft. Broker has already verified bytes/digests.
		for (const file of files) {
			if (!isAbsolute(file.path) || /[\x00-\x1f\x7f]/.test(file.path)) {
				throw new BridgeError("invalid_attachment_path", "The staged attachment has an unsafe path");
			}
			if (isImageAttachment(file.path) && !/\.(?:png|jpe?g|gif|webp)$/i.test(file.path)) {
				throw new BridgeError("image_format_unsupported", "OMP's native image paste supports PNG, JPEG, GIF and WebP paths. Export this image to one of those formats before transferring; the draft was not changed.");
			}
			const info = await stat(file.path);
			if (!info.isFile() || info.size !== file.size) {
				throw new BridgeError("attachment_changed", `Staged attachment is missing or changed: ${file.name}`);
			}
		}
		const images = [...new Set(files.filter(file => isImageAttachment(file.path)).map(file => file.path))];
		const ordinary = files.filter(file => !isImageAttachment(file.path));
		if (images.length && typeof this.ctx.ui.pasteToEditor !== "function") {
			throw new BridgeError("image_paste_unavailable", "This OMP host does not expose native image paste; the draft was not changed");
		}
		this.#assertCurrent(identity, destination);
		if (ordinary.length) {
			// Read the latest text after validation, preserving any existing native image atoms.
			const before = this.ctx.ui.getEditorText();
			const references = ordinary.map(file => JSON.stringify(file.path)).join(" ");
			const separator = before.length > 0 && !/\s$/.test(before) ? " " : "";
			const next = `${before}${separator}${references}\n[Client bridge: ${INBOX_REMINDER}]\n`;
			this.ctx.ui.setEditorText(next);
			this.#assertCurrent(identity, destination);
			if (this.ctx.ui.getEditorText() !== next) {
				throw new BridgeError("editor_update_failed", "OMP did not retain the transferred file references in the original draft");
			}
		}
		if (images.length) {
			this.#assertCurrent(identity, destination);
			// An image-only paste enters OMP's native attachment loader, never quoted-path prose.
			// This void API acknowledges handoff, not asynchronous preview completion. Do not replay.
			this.ctx.ui.pasteToEditor(images.map(path => JSON.stringify(pathToFileURL(path).href)).join(" "));
		}
		if (ordinary.length) this.ctx.ui.notify(`Client bridge: ${INBOX_REMINDER}`, "info");
	}

	async settled(): Promise<void> {
		await Promise.all([...this.#pending.values()]);
	}

	close(): void {
		if (this.#closed) return;
		this.#publish(undefined);
		this.#closed = true;
		this.#channel?.close();
		this.#channel = undefined;
	}
}
