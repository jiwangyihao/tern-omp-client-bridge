// SPDX-License-Identifier: MPL-2.0
// Run: bun tests/tern/run-routing.ts /absolute/path/to/luau
// Executes shipped window.luau against controlled async SDK receipts and fresh contexts.
// Synthetic boundary only: no Tern process, OS clipboard, editor, or native platform evidence.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const executable = process.argv[2];
if (!executable) throw new Error("Usage: bun tests/tern/run-routing.ts /absolute/path/to/luau");
const directory = await mkdtemp(join(tmpdir(), "bridge-luau-routing-"));
try {
	const harness = await readFile(new URL("./routing-harness.luau", import.meta.url), "utf8");
	const plugin = await readFile(new URL("../../tern/window.luau", import.meta.url), "utf8");
	const path = join(directory, "routing.luau");
	await writeFile(path, `${harness}\nrun(function()\n${plugin}\nend)\n`);
	const child = Bun.spawn([executable, path], { stdout: "inherit", stderr: "inherit" });
	const status = await child.exited;
	if (status !== 0) throw new Error(`Synthetic shipped-plugin destination regression failed: ${status}`);
} finally { await rm(directory, { recursive: true, force: true }); }
