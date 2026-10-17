// SPDX-License-Identifier: MPL-2.0
import { chmod, cp, mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "dist");
const stage = path.join(root, `.dist-${crypto.randomUUID()}`);
const PackageSchema = z.object({ files: z.array(z.string()), bin: z.record(z.string(), z.string()) });
const metadata = PackageSchema.parse(JSON.parse(await readFile(path.join(root, "package.json"), "utf8")));

// Bun executes TypeScript natively. Preserve the module tree rather than bundling:
// worker.ts is launched relative to runtime/index.ts, and the SDK resolves native
// modules, Python/prelude assets and platform packages from its installed tree.
// The resulting package requires Bun and its pinned dependencies, not a standalone binary.
try {
	await mkdir(stage);
	for (const entry of [...metadata.files, "package.json"]) {
		if (path.isAbsolute(entry) || entry.split(/[\\/]/).includes("..")) throw new Error("Package files must remain inside the package root");
		await cp(path.join(root, entry), path.join(stage, entry), { recursive: true, errorOnExist: true, force: false });
	}
	for (const entry of Object.values(metadata.bin)) await chmod(path.join(stage, entry), 0o755);
	await rm(output, { recursive: true, force: true });
	await rename(stage, output);
	console.log("Built dist/ with native runtime worker and package metadata. Install pinned dependencies with bun install --frozen-lockfile --ignore-scripts; this is not a single-file binary.");
} finally { await rm(stage, { recursive: true, force: true }); }
