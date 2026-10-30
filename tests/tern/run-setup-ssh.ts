// SPDX-License-Identifier: MPL-2.0
// Run: bun tests/tern/run-setup-ssh.ts /absolute/path/to/luau
// Runs shipped discovery against synthetic native receipts; no SSH authentication or user files.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const executable = process.argv[2];
if (!executable) throw new Error("Usage: bun tests/tern/run-setup-ssh.ts /absolute/path/to/luau");
const directory = await mkdtemp(join(tmpdir(), "bridge-luau-setup-ssh-"));
try {
	const [harness, discovery, target] = await Promise.all([
		readFile(new URL("./setup-ssh-harness.luau", import.meta.url), "utf8"),
		readFile(new URL("../../tern/setup-ssh.luau", import.meta.url), "utf8"),
		readFile(new URL("../../tern/setup-target.luau", import.meta.url), "utf8"),
	]);
	await Promise.all([
		writeFile(join(directory, "setup-ssh.luau"), discovery),
		writeFile(join(directory, "setup-target.luau"), target),
		writeFile(join(directory, "harness.luau"), `${harness}\nrun(require("./setup-ssh"))\n`),
	]);
	const child = Bun.spawn([executable, join(directory, "harness.luau")], { stdout: "inherit", stderr: "inherit" });
	assert.equal(await child.exited, 0, "Shipped SSH discovery behavioral regression failed");
} finally {
	await rm(directory, { recursive: true, force: true });
}
