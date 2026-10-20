// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rm, stat } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import type { CaptureResult } from "../api.ts";
import { protectPrivatePath } from "../config.ts";
import { BridgeError } from "../protocol.ts";

export interface CapturedFile {
	readonly name: string;
	readonly path: string;
	readonly size: number;
	readonly owned: boolean;
}
interface Capture {
	readonly directory: string;
	readonly files: readonly CapturedFile[];
	detach?: () => void;
	releasing?: Promise<void>;
}

/** Local-human-only source. The executor's model-tool registry must never expose it. */
export class HumanTransferSource {
	readonly #root: string;
	readonly #captures = new Map<string, Capture>();
	readonly #pending = new Set<Promise<CaptureResult>>();
	#closed = false;

	constructor(options: { stateDir: string }) {
		this.#root = join(options.stateDir, "captures", randomUUID());
	}

	capture(input: { kind: "files"; paths: string[] }, signal?: AbortSignal): Promise<CaptureResult> {
		if (this.#closed) return Promise.reject(new BridgeError("SOURCE_CLOSED", "Transfer source is closed"));
		const pending = this.#capture(input, signal);
		this.#pending.add(pending);
		void pending.finally(() => this.#pending.delete(pending)).catch(() => {});
		return pending;
	}

	/** Snapshot already-approved PNG bytes; this source never reads the clipboard itself. */
	captureImage(bytes: Uint8Array, signal?: AbortSignal): Promise<CaptureResult> {
		if (this.#closed) return Promise.reject(new BridgeError("SOURCE_CLOSED", "Transfer source is closed"));
		if (signal?.aborted) return Promise.reject(signal.reason);
		if (bytes.byteLength === 0) return Promise.reject(new BridgeError("NO_CLIPBOARD_IMAGE", "The clipboard image is empty"));
		// Own the bytes before the first yield; later clipboard or caller mutations cannot change them.
		const pending = this.#captureImage(Buffer.from(bytes), signal);
		this.#pending.add(pending);
		void pending.finally(() => this.#pending.delete(pending)).catch(() => {});
		return pending;
	}

	async #captureImage(bytes: Buffer, signal?: AbortSignal): Promise<CaptureResult> {
		const id = randomUUID();
		const directory = join(this.#root, id);
		const check = () => {
			signal?.throwIfAborted();
			if (this.#closed) throw new BridgeError("SOURCE_CLOSED", "Transfer source closed during capture");
		};
		try {
			check();
			await mkdir(directory, { recursive: true, mode: 0o700 });
			await protectPrivatePath(directory, true);
			check();
			const path = join(directory, "0.png");
			const file = await open(path, "wx", 0o600);
			try { await file.writeFile(bytes, { signal }); } finally { await file.close(); }
			check();
			return this.#publish(id, { directory, files: Object.freeze([Object.freeze({ name: "clipboard.png", path, size: bytes.length, owned: true })]) }, signal);
		} catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
	}

	#publish(id: string, capture: Capture, signal?: AbortSignal): CaptureResult {
		this.#captures.set(id, capture);
		if (signal) {
			// Keep abandonment cleanup until an upload synchronously claims ownership.
			const abort = () => { void this.release(id).catch(() => {}); };
			signal.addEventListener("abort", abort, { once: true });
			capture.detach = () => signal.removeEventListener("abort", abort);
		}
		return { id, kind: "files", names: capture.files.map(file => file.name) };
	}

	async #capture(input: { kind: "files"; paths: string[] }, signal?: AbortSignal): Promise<CaptureResult> {
		const check = () => {
			signal?.throwIfAborted();
			if (this.#closed) throw new BridgeError("SOURCE_CLOSED", "Transfer source closed during capture");
		};
		check();
		if (!input || input.kind !== "files" || !Array.isArray(input.paths) || input.paths.length === 0 || input.paths.some(path => typeof path !== "string")) {
			throw new BridgeError("CAPTURE_INPUT", "Capture requires explicitly selected file paths");
		}
		const paths = [...input.paths];
		if (paths.length > 256) throw new BridgeError("CAPTURE_LIMIT", "A transfer accepts at most 256 files");
		const id = randomUUID();
		const directory = join(this.#root, id);
		try {
			await mkdir(directory, { recursive: true, mode: 0o700 });
			check();
			await protectPrivatePath(directory, true);
			const files: CapturedFile[] = [];
			for (const [index, source] of paths.entries()) {
				check();
				if (!isAbsolute(source) || source.includes("\0")) throw new BridgeError("CAPTURE_PATH", "Dropped files must have absolute native paths");
				const inputFile = await open(source, constants.O_RDONLY | constants.O_NONBLOCK);
				try {
					const before = await inputFile.stat();
					check();
					if (!before.isFile()) throw new BridgeError("CAPTURE_TYPE", `Only regular files can be attached: ${basename(source)}`);
					const path = join(directory, String(index));
					// Copy bytes through owned descriptors: preserve destination ACLs and pin the opened source.
					const snapshotFile = await open(path, "wx", 0o600);
					try {
						const buffer = Buffer.allocUnsafe(Math.min(256 * 1024, before.size));
						let offset = 0;
						while (offset < before.size) {
							check();
							const { bytesRead } = await inputFile.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
							check();
							if (bytesRead === 0) throw new BridgeError("CAPTURE_CHANGED", `File changed while capturing: ${basename(source)}`);
							let written = 0;
							while (written < bytesRead) {
								check();
								const { bytesWritten } = await snapshotFile.write(buffer, written, bytesRead - written, offset + written);
								if (bytesWritten === 0) throw new BridgeError("CAPTURE_WRITE", "Snapshot write made no progress");
								written += bytesWritten;
							}
							offset += bytesRead;
						}
						check();
					} finally { await snapshotFile.close(); }
					const [after, current, snapshot] = await Promise.all([inputFile.stat(), stat(source), stat(path)]);
					if (before.dev !== current.dev || before.ino !== current.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || snapshot.size !== before.size) {
						throw new BridgeError("CAPTURE_CHANGED", `File changed while capturing: ${basename(source)}`);
					}
					files.push({ name: basename(source), path, size: snapshot.size, owned: true });
				} finally { await inputFile.close(); }
			}
			check();
			const capture: Capture = { directory, files: Object.freeze(files.map(file => Object.freeze(file))) };
			return this.#publish(id, capture, signal);
		} catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
	}

	files(captureId: string): readonly CapturedFile[] {
		const capture = this.#captures.get(captureId);
		if (!capture || capture.releasing) throw new BridgeError("CAPTURE_MISSING", "Capture is missing or has been released");
		return capture.files;
	}

	/** Transfer cancellation ownership from the originating request to the upload, without yielding. */
	claim(captureId: string): readonly CapturedFile[] {
		const files = this.files(captureId);
		const capture = this.#captures.get(captureId)!;
		capture.detach?.();
		capture.detach = undefined;
		return files;
	}

	async release(captureId: string): Promise<void> {
		const capture = this.#captures.get(captureId);
		if (!capture) return;
		if (!capture.releasing) {
			capture.detach?.();
			capture.detach = undefined;
			// Invalidate synchronously: an upload must not claim files already being removed.
			capture.releasing = rm(capture.directory, { recursive: true, force: true }).then(() => { this.#captures.delete(captureId); });
		}
		await capture.releasing;
	}

	async close(): Promise<void> {
		this.#closed = true;
		await Promise.allSettled(this.#pending);
		await Promise.all([...this.#captures.keys()].map(id => this.release(id)));
		await rm(this.#root, { recursive: true, force: true });
	}
}
