// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from "node:crypto";
import { BridgeError, type InvocationTarget } from "../protocol.ts";
import { canonicalPath, decodeClientUri, encodeClientPath, isClientUri } from "./uri.ts";

interface Snapshot {
	readonly target: InvocationTarget;
	readonly path: string;
	readonly nativeTag: string;
}

export class Snapshots {
	readonly #snapshots = new Map<string, Snapshot>();
	readonly #aliases = new Map<string, string>();

	header(target: InvocationTarget, path: string, nativeTag: string): string {
		const key = JSON.stringify([target.sessionId, target.contextId, target.device.id, canonicalPath(path, target.device.platform), nativeTag]);
		let alias = this.#aliases.get(key);
		if (!alias) {
			alias = randomUUID();
			this.#aliases.set(key, alias);
			this.#snapshots.set(alias, { target, path, nativeTag });
		}
		return `[${encodeClientPath(path, target.device.platform)}?__bridge_snapshot=${alias}#${nativeTag}]`;
	}

	/** Remove only our reserved query field; other query bytes are native syntax. */
	decode(uri: string, target: InvocationTarget, nativeTag?: string): string {
		const question = uri.indexOf("?");
		const fields = question < 0 ? [] : uri.slice(question + 1).split("&");
		const provenance = fields.filter(field => field.split("=", 1)[0] === "__bridge_snapshot");
		if (!provenance.length) {
			if (nativeTag !== undefined) throw new BridgeError("STALE_CLIENT_SNAPSHOT", "Client edits require the complete snapshot URI, including its provenance query.");
			return decodeClientUri(uri, target.device.platform);
		}
		if (provenance.length !== 1) throw new BridgeError("STALE_CLIENT_SNAPSHOT", "Duplicate client snapshot provenance is invalid.");
		const token = /^__bridge_snapshot=([a-f0-9-]{36})(:.*)?$/.exec(provenance[0]!);
		const snapshot = token ? this.#snapshots.get(token[1]!) : undefined;
		if (!snapshot || snapshot.target.sessionId !== target.sessionId || snapshot.target.contextId !== target.contextId || snapshot.target.device.id !== target.device.id || (nativeTag !== undefined && snapshot.nativeTag.toLowerCase() !== nativeTag.toLowerCase())) {
			throw new BridgeError("STALE_CLIENT_SNAPSHOT", "Client snapshot does not belong to this device and execution context. Read the file on the selected client again.");
		}
		const remaining = fields.filter(field => field !== provenance[0]).join("&");
		const path = decodeClientUri(uri.slice(0, question) + (token?.[2] ?? "") + (remaining ? `?${remaining}` : ""), target.device.platform);
		const normalized = canonicalPath(path, target.device.platform);
		const expected = canonicalPath(snapshot.path, target.device.platform);
		if (normalized !== expected && (nativeTag !== undefined || !(normalized.startsWith(`${expected}:`) || normalized.startsWith(`${expected}?`)))) {
			throw new BridgeError("STALE_CLIENT_SNAPSHOT", "Client snapshot provenance names a different file.");
		}
		return path;
	}

	translate(input: string, target: InvocationTarget): string {
		let files = 0;
		const lines = input.split("\n").map(line => {
			// Addition bodies are opaque, even when they contain protocol-looking text.
			if (line.startsWith("+") || !line.trim()) return line;
			const header = /^\s*\[(.+)#([a-f0-9]{4})\]\s*$/i.exec(line);
			if (header) {
				const [, uri, tag] = header;
				if (!uri || !tag || !isClientUri(uri)) throw new BridgeError("MIXED_RESOURCE_EDIT", "Every file in a client edit must use a client:/// snapshot header.");
				const path = this.decode(uri, target, tag);
				files++;
				return `[${path}#${tag}]`;
			}
			const move = /^\s*MV\s+(.+?)\s*$/.exec(line);
			if (move) {
				if (!files) throw new BridgeError("INVALID_CLIENT_EDIT", "A move requires a client snapshot header.");
				let destination = move[1]!;
				if (destination.startsWith('"')) {
					try {
						const decoded: unknown = JSON.parse(destination);
						if (typeof decoded !== "string") throw new Error("not a string");
						destination = decoded;
					} catch {
						throw new BridgeError("INVALID_CLIENT_EDIT", "Use a JSON-quoted client URI for a quoted move destination.");
					}
				}
				if (!isClientUri(destination)) throw new BridgeError("MIXED_RESOURCE_EDIT", "A client edit cannot move a file to an agent-host path.");
				return `MV ${JSON.stringify(this.decode(destination, target))}`;
			}
			if (!files || !/^\s*(?:PUT\s|CUT\s|REM\s*$)/.test(line)) {
				throw new BridgeError("INVALID_CLIENT_EDIT", "Client edits require hashline headers and PUT/CUT/REM/MV operations; no unscoped or mixed-host patch sections are allowed.");
			}
			return line;
		});
		if (!files) throw new BridgeError("INVALID_CLIENT_EDIT", "A client edit requires a previously returned client snapshot header.");
		return lines.join("\n");
	}

	forgetContext(contextId: string): void {
		for (const [alias, snapshot] of this.#snapshots) if (snapshot.target.contextId === contextId) this.#snapshots.delete(alias);
		for (const [key, alias] of this.#aliases) if (!this.#snapshots.has(alias)) this.#aliases.delete(key);
	}
}
