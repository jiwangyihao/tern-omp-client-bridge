// SPDX-License-Identifier: MPL-2.0
// Dependency-free: remote staging verifies source before installing/importing package dependencies.
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { packageFiles } from "../scripts/build.ts";

export async function inspectSetupPackage(packageRoot: string): Promise<{ files: string[]; digest: string }> {
	const files = await packageFiles(packageRoot);
	const hash = createHash("sha256");
	let size = 0;
	for (const relative of files) {
		const absolute = path.join(packageRoot, relative);
		const info = await lstat(absolute);
		if (!info.isFile() || info.isSymbolicLink() || (size += info.size) > 32 * 1024 * 1024) throw new Error("Bridge source must contain only link-free regular files and remain within 32 MiB.");
		hash.update(relative.split(path.sep).join("/")); hash.update("\0"); hash.update(await readFile(absolute)); hash.update("\0");
	}
	return { files, digest: hash.digest("hex") };
}
