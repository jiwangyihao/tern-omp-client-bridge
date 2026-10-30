// SPDX-License-Identifier: MPL-2.0
import { createHash, type Hash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, open, rename, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ImportedFile } from "./api.ts";
import { protectPrivatePath } from "./config.ts";
import { INBOX_README } from "./inbox-guidance.ts";
import { BridgeError } from "./protocol.ts";

const runFile = promisify(execFile);

export interface UploadInput {
	readonly viewId: string;
	readonly sessionId: string;
	readonly draftToken: string;
	readonly files: readonly { readonly name: string; readonly size: number }[];
}
export interface CompletedUpload {
	readonly id: string;
	readonly viewId: string;
	readonly sessionId: string;
	readonly draftToken: string;
	readonly files: readonly ImportedFile[];
}
interface Entry {
	readonly name: string;
	readonly filename: string;
	readonly size: number;
	readonly handle: FileHandle;
	readonly hash: Hash;
	bytes: number;
	closed: boolean;
}
interface Upload {
	readonly id: string;
	readonly clientId: string;
	readonly input: UploadInput;
	readonly entries: Entry[];
	directory: string;
	bytesSent: number;
	cancelled: boolean;
	active?: Promise<unknown>;
	cleanup?: Promise<void>;
	failure?: unknown;
	completed?: CompletedUpload;
}

/** Only fully verified, atomically published assets are eligible for draft attachment. */
export class UploadStore {
	readonly #uploads = new Map<string, Upload>();
	#closed = false;
	constructor(private readonly root: string) {}

	async begin(clientId: string, input: UploadInput): Promise<{ id: string }> {
		if (this.#closed) throw new BridgeError("BRIDGE_CLOSED", "The upload store is closed");
		if (!input.files.length || input.files.length > 256 || input.files.some(file => !Number.isSafeInteger(file.size) || file.size < 0 || !file.name || file.name.includes("\0"))) throw new BridgeError("INVALID_UPLOAD", "Invalid file names, sizes or file count");
		if (!Number.isSafeInteger(input.files.reduce((sum, file) => sum + file.size, 0))) throw new BridgeError("INVALID_UPLOAD", "The total file size exceeds the supported range");
		const id = crypto.randomUUID();
		const upload: Upload = { id, clientId, input, entries: [], directory: path.join(this.root, id + ".partial"), bytesSent: 0, cancelled: false };
		this.#uploads.set(id, upload);
		const opening = (async () => {
			await mkdir(upload.directory, { recursive: true, mode: 0o700 });
			await protectPrivatePath(upload.directory, true);
			for (const [index, file] of input.files.entries()) {
				if (upload.cancelled) throw new BridgeError("CANCELLED", "Upload cancelled before opening the next file");
				let safeName = file.name.replaceAll("\\", "/").split("/").at(-1)!.replace(/[\x00-\x1f<>:"|?*]/g, "_").replace(/[. ]+$/, "") || "file";
				const prefix = `${index}-`;
				// Reserve the index prefix within the filesystem's UTF-8 component limit.
				const availableBytes = 255 - prefix.length;
				if (Buffer.byteLength(safeName, "utf8") > availableBytes) {
					const bytes = Buffer.from(safeName, "utf8");
					let start = bytes.length - availableBytes;
					while ((bytes[start]! & 0xc0) === 0x80) start++;
					safeName = bytes.toString("utf8", start);
				}
				const filename = prefix + safeName;
				const handle = await open(path.join(upload.directory, filename), "wx", 0o600);
				upload.entries.push({ name: file.name, filename, size: file.size, handle, hash: createHash("sha256"), bytes: 0, closed: false });
			}
		})();
		upload.active = opening;
		try { await opening; if (upload.cancelled) throw new BridgeError("CANCELLED", "Upload cancelled during initialization"); return { id }; }
		catch (error) { if (upload.cleanup) await upload.cleanup; else await this.cancel(clientId, id); throw error; }
		finally { upload.active = undefined; }
	}

	#owned(clientId: string, id: string): Upload {
		const upload = this.#uploads.get(id);
		if (!upload || upload.clientId !== clientId) throw new BridgeError("UPLOAD_UNAVAILABLE", "Upload is missing or belongs to another client");
		return upload;
	}

	async chunk(clientId: string, input: { id: string; index: number; offset: number; data: string }, signal?: AbortSignal): Promise<{ bytesSent: number }> {
		const upload = this.#owned(clientId, input.id);
		if (upload.cancelled) throw new BridgeError("CANCELLED", "Upload cancelled");
		if (upload.completed) throw new BridgeError("UPLOAD_COMPLETE", "Completed files cannot be mutated");
		if (upload.failure) throw upload.failure;
		if (upload.active) throw new BridgeError("UPLOAD_BUSY", "Wait for the preceding upload operation");
		const entry = upload.entries[input.index];
		if (!entry || !Number.isSafeInteger(input.index) || input.offset !== entry.bytes) throw new BridgeError("UPLOAD_OFFSET", "Upload file index or offset does not match the verified prefix");
		const bytes = Buffer.from(input.data, "base64");
		if (!bytes.length || bytes.length > 256 * 1024 || bytes.toString("base64") !== input.data || entry.bytes + bytes.length > entry.size) throw new BridgeError("INVALID_UPLOAD_CHUNK", "Invalid base64, chunk size or declared file length");
		const writing = (async () => {
			let written = 0;
			while (written < bytes.length) {
				signal?.throwIfAborted();
				if (upload.cancelled) throw new BridgeError("CANCELLED", "Upload cancelled during transfer");
				const result = await entry.handle.write(bytes, written, bytes.length - written, entry.bytes + written);
				if (!result.bytesWritten) throw new BridgeError("UPLOAD_WRITE_FAILED", "The destination did not accept file bytes");
				written += result.bytesWritten;
			}
			entry.hash.update(bytes);
			entry.bytes += bytes.length;
			upload.bytesSent += bytes.length;
		})();
		upload.active = writing;
		try { await writing; return { bytesSent: upload.bytesSent }; }
		catch (error) { upload.failure = error; throw error; }
		finally { upload.active = undefined; }
	}

	async finish(clientId: string, id: string, digests: readonly string[]): Promise<CompletedUpload> {
		const upload = this.#owned(clientId, id);
		if (upload.cancelled) throw new BridgeError("CANCELLED", "Upload cancelled");
		if (upload.completed) return upload.completed;
		if (upload.failure) throw upload.failure;
		if (upload.active) throw new BridgeError("UPLOAD_BUSY", "Wait for the preceding upload operation");
		if (digests.length !== upload.entries.length || upload.entries.some(entry => entry.bytes !== entry.size)) throw new BridgeError("UPLOAD_INCOMPLETE", "Every declared byte must arrive before completion");
		const finishing = (async () => {
			const verified = upload.entries.map((entry, index) => {
				const sha256 = entry.hash.digest("hex");
				if (sha256 !== digests[index]) throw new BridgeError("UPLOAD_CHECKSUM", `The received content did not match file ${index + 1}`);
				return { name: entry.name, path: path.join(this.root, id, entry.filename), size: entry.bytes, sha256 };
			});
			for (const entry of upload.entries) { await entry.handle.sync(); await entry.handle.close(); entry.closed = true; }
			// Publish guidance and verified bytes together; numeric file prefixes reserve README.
			const readme = await open(path.join(upload.directory, "README"), "wx", 0o600);
			try { await readme.writeFile(INBOX_README, "utf8"); await readme.sync(); }
			finally { await readme.close(); }
			if (upload.cancelled) throw new BridgeError("CANCELLED", "Upload cancelled before publication");
			const destination = path.join(this.root, id);
			if (process.platform === "win32") {
				// Bun 1.4.3 rename can replace an unrelated file with this directory on Windows.
				// Directory.Move uses a same-volume move without replacement, not a check/copy.
				const sourcePath = Buffer.from(path.resolve(upload.directory), "utf8").toString("base64");
				const destinationPath = Buffer.from(path.resolve(destination), "utf8").toString("base64");
				const script = `$ErrorActionPreference = 'Stop'; [IO.Directory]::Move([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${sourcePath}')), [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${destinationPath}')))`;
				await runFile("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true });
			} else await rename(upload.directory, destination);
			upload.directory = destination;
			if (upload.cancelled) throw new BridgeError("CANCELLED", "Upload cancelled before attachment became available");
			upload.completed = Object.freeze({ id, viewId: upload.input.viewId, sessionId: upload.input.sessionId, draftToken: upload.input.draftToken, files: Object.freeze(verified.map(file => Object.freeze(file))) });
			return upload.completed;
		})();
		upload.active = finishing;
		try { return await finishing; }
		catch (error) { upload.failure = error; throw error; }
		finally { upload.active = undefined; }
	}

	completed(clientId: string, id: string): CompletedUpload {
		const result = this.#owned(clientId, id).completed;
		if (!result) throw new BridgeError("UPLOAD_INCOMPLETE", "Only checksum-verified files can be attached");
		return result;
	}

	async cancel(clientId: string, id: string): Promise<void> {
		const upload = this.#owned(clientId, id);
		if (upload.completed) return; // Referenced remote assets outlive the transfer connection.
		if (upload.cleanup) return upload.cleanup;
		upload.cancelled = true;
		upload.cleanup = (async () => {
			if (upload.active) await Promise.allSettled([upload.active]);
			for (const entry of upload.entries) if (!entry.closed) { await entry.handle.close(); entry.closed = true; }
			await rm(upload.directory, { recursive: true, force: true });
			this.#uploads.delete(id);
		})();
		return upload.cleanup;
	}

	async cancelClient(clientId: string): Promise<void> {
		for (const upload of this.#uploads.values()) if (upload.clientId === clientId && !upload.completed) await this.cancel(clientId, upload.id);
	}

	async close(): Promise<void> {
		this.#closed = true;
		for (const upload of this.#uploads.values()) if (!upload.completed) await this.cancel(upload.clientId, upload.id);
	}
}
