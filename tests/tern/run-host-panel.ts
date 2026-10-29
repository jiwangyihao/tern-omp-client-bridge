// SPDX-License-Identifier: MPL-2.0
// Run: bun tests/tern/run-host-panel.ts /absolute/path/to/luau
// Synthetic boundary only: executes shipped host.luau, not Tern or a native renderer.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const executable = process.argv[2];
if (!executable) throw new Error("Usage: bun tests/tern/run-host-panel.ts /absolute/path/to/luau");
const directory = await mkdtemp(join(tmpdir(), "bridge-luau-host-panel-"));
try {
	const harness = await readFile(new URL("./host-panel-harness.luau", import.meta.url), "utf8");
	const plugin = await readFile(new URL("../../tern/host.luau", import.meta.url), "utf8");
	const setupView = await readFile(new URL("../../tern/setup-ui/view.luau", import.meta.url), "utf8");
	const path = join(directory, "host-panel.luau");
	await writeFile(path, `${harness}\nrun(function()\nlocal require = function(name) assert(name == './setup-ui/view'); return (function()\n${setupView}\nend)() end\n${plugin}\nend)\n`);
	const child = Bun.spawn([executable, path], { stdout: "inherit", stderr: "inherit" });
	const status = await child.exited;
	if (status !== 0) throw new Error(`Synthetic shipped-host panel regression failed: ${status}`);
} finally { await rm(directory, { recursive: true, force: true }); }
