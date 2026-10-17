// SPDX-License-Identifier: MPL-2.0
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { ExtensionContext, TerminalInputHandler } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { BrokerApi, ImportedFile, ServerState } from "../api.ts";
import { ControlFrameDecoder } from "../control-frame.ts";
import { BridgeError } from "../protocol.ts";
import { isImageAttachment } from "../transfers/policy.ts";

export interface DraftContext extends Pick<ExtensionContext, "mode" | "hasUI" | "agent"> {
	readonly sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId">;
	readonly ui: Pick<ExtensionContext["ui"], "onTerminalInput" | "supportsEditor" | "setEditorText" | "getEditorText" | "notify">;
}

export interface DraftIdentity {
	readonly sessionId: string;
	readonly token: string;
}

/** Owns one actual OMP composer's lifetime, independently of execution-device selection. */
export class DraftBridge {
	#identity: DraftIdentity;
	#decoder = new ControlFrameDecoder();
	#unsubscribe: (() => void) | undefined;
	#closed = false;
	#pending = new Set<Promise<void>>();

	constructor(
		private readonly broker: Pick<BrokerApi, "claimIntent" | "finishIntent">,
		private readonly ctx: DraftContext,
		private readonly onState: (state: ServerState) => void,
	) {
		this.#identity = { sessionId: ctx.sessionManager.getSessionId(), token: crypto.randomUUID() };
		if (ctx.mode === "tui" && ctx.hasUI && ctx.agent.kind === "main") {
			this.#unsubscribe = ctx.ui.onTerminalInput(this.handleInput);
		}
	}

	get identity(): DraftIdentity {
		return this.#identity;
	}

	/** Called on submitted interactive input, never on editor change/keystroke. */
	submitted(): void {
		this.#identity = { sessionId: this.ctx.sessionManager.getSessionId(), token: crypto.randomUUID() };
	}

	readonly handleInput: TerminalInputHandler = data => {
		if (this.#closed) return undefined;
		const decoded = this.#decoder.push(data);
		const identity = this.#identity;
		for (const id of decoded.intentIds) {
			const operation = this.#claim(id, identity);
			this.#pending.add(operation);
			void operation.finally(() => this.#pending.delete(operation));
		}
		if (decoded.text === data) return undefined;
		return decoded.text ? { data: decoded.text } : { consume: true };
	};

	#assertCurrent(identity: DraftIdentity): void {
		if (this.#closed || this.#identity !== identity || this.ctx.sessionManager.getSessionId() !== identity.sessionId) {
			throw new BridgeError("draft_changed", "The original OMP draft was submitted, replaced, or closed; attachment was not retargeted");
		}
	}

	async #claim(id: string, identity: DraftIdentity): Promise<void> {
		try {
			this.#assertCurrent(identity);
			const claim = await this.broker.claimIntent(id, identity.sessionId, identity.token);
			this.#assertCurrent(identity);
			this.onState(claim.state);
			if (claim.kind === "attach") {
				if (!this.ctx.ui.supportsEditor || this.ctx.mode !== "tui") {
					throw new BridgeError("editor_unavailable", "This OMP host does not expose an interactive draft editor");
				}
				if (!claim.files?.length) throw new BridgeError("empty_attachment", "The verified transfer contains no files");
				await this.#attach(claim.files, identity);
			}
			await this.broker.finishIntent(id);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			try {
				await this.broker.finishIntent(id, message);
			} catch {
				// Never replay an attachment because its completion receipt was lost.
			}
			if (!this.#closed) this.ctx.ui.notify(`Client bridge: ${message}`, "error");
		}
	}

	async #attach(files: readonly ImportedFile[], identity: DraftIdentity): Promise<void> {
		// Validate all files before touching the draft. Broker has already verified bytes/digests.
		for (const file of files) {
			if (!isAbsolute(file.path) || /[\x00-\x1f\x7f]/.test(file.path)) {
				throw new BridgeError("invalid_attachment_path", "The staged attachment has an unsafe path");
			}
			if (isImageAttachment(file.path)) {
				throw new BridgeError("image_attachment_unsupported", "Image attachments are not supported by this pure-plugin bridge. Transfer an ordinary file reference instead; the draft was not changed.");
			}
			const info = await stat(file.path);
			if (!info.isFile() || info.size !== file.size) {
				throw new BridgeError("attachment_changed", `Staged attachment is missing or changed: ${file.name}`);
			}
		}
		// Read the latest text only after all asynchronous validation has completed.
		// One synchronous core-editor update cannot enter the image/video paste path.
		const before = this.ctx.ui.getEditorText();
		const references = files.map(file => JSON.stringify(file.path)).join(" ");
		const separator = before.length > 0 && !/\s$/.test(before) ? " " : "";
		const next = `${before}${separator}${references} `;
		this.#assertCurrent(identity);
		this.ctx.ui.setEditorText(next);
		this.#assertCurrent(identity);
		if (this.ctx.ui.getEditorText() !== next) {
			throw new BridgeError("editor_update_failed", "OMP did not retain the transferred file references in the original draft");
		}
	}

	async settled(): Promise<void> {
		await Promise.all([...this.#pending]);
	}

	close(): void {
		this.#closed = true;
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		this.#decoder.flush();
	}
}
