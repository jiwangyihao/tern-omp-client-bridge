// SPDX-License-Identifier: MPL-2.0
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BridgeError } from "./protocol.ts";

/** Lexical path policy only; resolution also checks the actual executable file. */
export function isAbsoluteTernExecutablePath(value: unknown, platform: NodeJS.Platform = process.platform): value is string {
	if (typeof value !== "string" || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return false;
	if (platform === "win32") {
		// win32.isAbsolute alone also accepts root-relative paths such as \\tern.exe.
		const parsed = path.win32.parse(value);
		return path.win32.isAbsolute(value) && parsed.root.length > 1 && parsed.base.length > 0 && parsed.ext.toLowerCase() === ".exe";
	}
	return path.posix.isAbsolute(value);
}

async function usableExecutable(value: unknown): Promise<boolean> {
	if (!isAbsoluteTernExecutablePath(value)) return false;
	try {
		// Follow links for validation, but retain the stable entrypoint, not realpath.
		if (!(await stat(value)).isFile()) return false;
		if (process.platform !== "win32") await access(value, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function conventionalExecutables(): string[] {
	const home = os.homedir();
	const name = process.platform === "win32" ? "tern.exe" : "tern";
	const candidates = [path.join(home, ".local", "bin", name)];
	if (process.platform === "darwin") {
		candidates.push(
			path.join(home, "Applications", "Tern.app", "Contents", "MacOS", "tern"),
			"/Applications/Tern.app/Contents/MacOS/tern",
			"/usr/local/bin/tern",
			"/opt/homebrew/bin/tern",
		);
	} else if (process.platform === "linux") {
		// APPIMAGE may belong to a parent editor rather than Tern.
		const appImage = process.env.APPIMAGE;
		if (appImage && /^tern(?:[ ._-]|$)/i.test(path.basename(appImage))) candidates.push(appImage);
		candidates.push("/usr/local/bin/tern", "/usr/bin/tern");
	} else if (process.platform === "win32") {
		if (process.env.LOCALAPPDATA) {
			candidates.push(
				path.join(process.env.LOCALAPPDATA, "Tern", "tern.exe"),
				path.join(process.env.LOCALAPPDATA, "Programs", "Tern", "tern.exe"),
			);
		}
		if (process.env.ProgramFiles) candidates.push(path.join(process.env.ProgramFiles, "Tern", "tern.exe"));
	}
	return candidates;
}

/** Resolve on the machine running setup/install, never in the GUI launch path. */
export async function resolveTernExecutable({ explicit, saved }: { explicit?: string; saved?: unknown } = {}): Promise<string> {
	if (explicit !== undefined) {
		if (await usableExecutable(explicit)) return explicit;
		throw new BridgeError("INVALID_TERN_EXECUTABLE", "Invalid --tern-executable: provide an absolute path to an existing Tern executable file (executable on POSIX, native .exe on Windows).");
	}
	if (typeof saved === "string" && await usableExecutable(saved)) return saved;
	const found = Bun.which(process.platform === "win32" ? "tern.exe" : "tern");
	if (found && await usableExecutable(found)) return found;
	for (const candidate of conventionalExecutables()) {
		if (await usableExecutable(candidate)) return candidate;
	}
	throw new BridgeError("TERN_EXECUTABLE_NOT_FOUND", "Tern executable not found. Install Tern or pass --tern-executable with its absolute executable path on this machine (native .exe on Windows).");
}
