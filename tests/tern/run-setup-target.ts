// SPDX-License-Identifier: MPL-2.0
// Run: bun tests/tern/run-setup-target.ts /absolute/path/to/luau
// Synthetic helper and local POSIX protocol coverage; never connects to SSH or mutates a remote.
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const executable = process.argv[2];
if (!executable) throw new Error("Usage: bun tests/tern/run-setup-target.ts /absolute/path/to/luau");
const directory = await mkdtemp(join(tmpdir(), "bridge-luau-setup-target-"));
try {
	const harness = await readFile(new URL("./setup-target-harness.luau", import.meta.url), "utf8");
	const helper = await readFile(new URL("../../tern/setup-target.luau", import.meta.url), "utf8");
	const path = join(directory, "setup-target.luau");
	await writeFile(join(directory, "helper.luau"), helper);
	await writeFile(path, `${harness}\nrun(require("./helper"))\n`);
	const child = Bun.spawn([executable, path], { stdout: "inherit", stderr: "inherit" });
	const status = await child.exited;
	assert.equal(status, 0, "Synthetic shipped setup-target regression failed");

	// Exercise the public argv builder, including its remote-shell quoting.
	const emitter = join(directory, "probe-command.luau");
	await writeFile(emitter, 'local helper = require("./helper")\nlocal args = helper.preflightArgs("fixture-host")\nprint(args[#args])\n');
	const emitted = Bun.spawn([executable, emitter], { stdout: "pipe", stderr: "pipe" });
	const [emitStatus, command, emitError] = await Promise.all([emitted.exited, new Response(emitted.stdout).text(), new Response(emitted.stderr).text()]);
	assert.equal(emitStatus, 0, emitError);
	const probe = command.trimEnd();
	const bin = join(directory, "bin");
	await mkdir(bin);
	for (const name of ["sh", "tar", "mkdir", "chmod", "mv", "uname"]) {
		const script = name === "uname"
			? '#!/bin/sh\ncase "$1" in -s) printf "%s\\n" "$PROBE_SYSTEM";; -m) printf "%s\\n" "$PROBE_ARCH";; *) exit 1;; esac\n'
			: name === "sh" ? '#!/bin/sh\nexec /bin/sh "$@"\n' : "#!/bin/sh\nexit 0\n";
		await writeFile(join(bin, name), script);
		await chmod(join(bin, name), 0o700);
	}
	const prefix = "TERN_OMP_SSH_PREFLIGHT_V1\t";
	async function checkProbe(overrides: Record<string, string>, expectedStatus: number, expectedOutput: string): Promise<void> {
		const process = Bun.spawn(["/bin/sh", "-c", probe], {
			env: { PATH: bin, HOME: directory, SHELL: "/bin/sh", PROBE_SYSTEM: "Linux", PROBE_ARCH: "x86_64", ...overrides },
			stdout: "pipe", stderr: "pipe",
		});
		const [status, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
		assert.equal(status, expectedStatus, "Probe exit protocol");
		assert.equal(stdout, prefix + expectedOutput + "\n", "Probe exact stdout protocol");
		assert.equal(stderr, "", "Probe clean stderr");
	}
	await checkProbe({}, 0, "Linux\tx86_64");
	await checkProbe({ PROBE_SYSTEM: "Darwin", PROBE_ARCH: "arm64" }, 0, "Darwin\tarm64");
	await checkProbe({ PROBE_SYSTEM: "FreeBSD" }, 20, "ERROR\tplatform");
	await checkProbe({ PROBE_ARCH: "s390x" }, 20, "ERROR\tplatform");
	await checkProbe({ HOME: "" }, 22, "ERROR\thome");
	await checkProbe({ HOME: "relative" }, 22, "ERROR\thome");
	await checkProbe({ HOME: join(directory, "absent") }, 22, "ERROR\thome");
	await checkProbe({ SHELL: "/bin/fish" }, 23, "ERROR\tshell");
	await rm(join(bin, "tar"));
	await checkProbe({}, 21, "ERROR\ttools");
	console.log("Read-only local POSIX probe protocol cases passed: 9");
} finally { await rm(directory, { recursive: true, force: true }); }
