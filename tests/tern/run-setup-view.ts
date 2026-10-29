// SPDX-License-Identifier: MPL-2.0
// Run: bun tests/tern/run-setup-view.ts /absolute/path/to/luau
// Synthetic SDK boundary only; native editing still needs a real Tern integration check.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const executable = process.argv[2];
if (!executable) throw new Error("Usage: bun tests/tern/run-setup-view.ts /absolute/path/to/luau");
const directory = await mkdtemp(join(tmpdir(), "bridge-luau-setup-view-"));
try {
	const harness = await readFile(new URL("./setup-view-harness.luau", import.meta.url), "utf8");
	const view = await readFile(new URL("../../tern/setup-ui/view.luau", import.meta.url), "utf8");
	const host = await readFile(new URL("../../tern/setup-ui/host.luau", import.meta.url), "utf8");
	const path = join(directory, "setup-view.luau");
	await writeFile(path, `${harness}\nrun(function()\n${view}\nend, function(require)\n${host}\nend)\n`);
	const child = Bun.spawn([executable, path], { stdout: "inherit", stderr: "inherit" });
	const status = await child.exited;
	if (status !== 0) throw new Error(`Synthetic shipped setup renderer regression failed: ${status}`);
} finally { await rm(directory, { recursive: true, force: true }); }
