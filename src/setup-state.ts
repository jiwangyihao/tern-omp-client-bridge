// SPDX-License-Identifier: MPL-2.0
import { link, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { protectPrivatePath, writePrivateJson } from "./config.ts";
import { BridgeError } from "./protocol.ts";

const OwnerSchema = z.object({ schema: z.literal(1), pid: z.number().int().positive(), instance: z.string().uuid() });

export function processExists(pid: number): boolean {
	try { process.kill(pid, 0); return true; }
	catch (error) { return !(error instanceof Error && "code" in error && error.code === "ESRCH"); }
}

export async function readOptionalJson(file: string): Promise<unknown | undefined> {
	try {
		const info = await lstat(file);
		if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new BridgeError("SETUP_CONFLICT", "Setup metadata must be a bounded regular file; inspect the configured directory before retrying.");
		return JSON.parse(await readFile(file, "utf8"));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

export async function privateDirectory(directory: string): Promise<void> {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const info = await lstat(directory);
	if (!info.isDirectory() || info.isSymbolicLink()) throw new BridgeError("SETUP_CONFLICT", "Setup requires a real, user-owned directory, not a symbolic link.");
	if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new BridgeError("SETUP_CONFLICT", "Setup will not adopt another user's directory.");
	await protectPrivatePath(directory, true);
}

/** Process ownership, not a timestamp, decides whether an interrupted setup is recoverable. */
export async function acquireSetupLock(file: string): Promise<() => Promise<void>> {
	await privateDirectory(path.dirname(file));
	const owner = { schema: 1 as const, pid: process.pid, instance: crypto.randomUUID() };
	async function create(): Promise<void> {
		const temporary = `${file}.${crypto.randomUUID()}.tmp`;
		try {
			await writeFile(temporary, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
			await protectPrivatePath(temporary);
			// Publish complete ownership metadata exclusively; interruption cannot leave an empty lock.
			await link(temporary, file);
		} finally { await rm(temporary, { force: true }); }
	}
	try { await create(); }
	catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
		const previous = OwnerSchema.safeParse(await readOptionalJson(file));
		if (!previous.success || processExists(previous.data.pid)) throw new BridgeError("SETUP_BUSY", "Another setup or managed service owns this directory. Wait for it to finish; if metadata is damaged, inspect the lock before removing it.");
		// A distinct recovery lock prevents two repairers from deleting a newly acquired lock.
		const recoveryFile = `${file}.recovery`;
		let releaseRecovery: (() => Promise<void>) | undefined;
		try {
			// The recovery guard stays held across rechecking, unlinking and exclusive acquisition.
			// A dead recovery owner can be reclaimed through the same ownership protocol.
			releaseRecovery = await acquireSetupLock(recoveryFile);
			const current = OwnerSchema.safeParse(await readOptionalJson(file));
			if (current.success && current.data.instance === previous.data.instance && !processExists(current.data.pid)) await rm(file);
			try { await create(); }
			catch { throw new BridgeError("SETUP_BUSY", "Another setup acquired this directory during recovery. Retry after it finishes."); }
		} finally { await releaseRecovery?.(); }
	}
	return async () => {
		const current = OwnerSchema.safeParse(await readOptionalJson(file));
		if (current.success && current.data.instance === owner.instance) await rm(file, { force: true });
	};
}

export const SetupProgressSchema = z.object({
	schema: z.literal(1), status: z.enum(["installing", "failed", "awaiting_session", "ready"]),
	stage: z.string().max(64), message: z.string().max(1024), host: z.string().max(255).optional(),
	updatedAt: z.number(), error: z.string().max(128).optional(), controlFile: z.string().max(32768).optional(),
});
export type SetupProgress = z.infer<typeof SetupProgressSchema>;

export async function writeSetupProgress(data: string, value: Omit<SetupProgress, "schema" | "updatedAt">): Promise<void> {
	await writePrivateJson(path.join(data, "setup-state.json"), SetupProgressSchema.parse({ schema: 1, ...value, updatedAt: Date.now() }));
}

export async function mergeControlFile(data: string, controlFile: string, ternExecutable: string, ternPaneSocket: string | undefined): Promise<void> {
	const file = path.join(data, "config.json");
	const previous = await readOptionalJson(file);
	const config = previous === undefined ? {} : z.record(z.string(), z.unknown()).parse(previous);
	await writePrivateJson(file, { ...config, controlFile, ternExecutable, ternPaneSocket });
}
