// SPDX-License-Identifier: MPL-2.0
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OmpRuntime } from "../../src/runtime/index.ts";

const root = process.argv[2];
if (process.platform !== "win32" || !root) throw new Error("Windows console fixture requires its private root");
const cwd = join(root, "workspace");
await mkdir(join(cwd, ".omp"), { recursive: true });
await writeFile(join(cwd, ".omp", "config.yml"), Bun.YAML.stringify({ tools: { approvalMode: "yolo", approval: { read: "allow" } } }));
const marker = `console-proof-${crypto.randomUUID()}`;
const input = join(cwd, "owned.txt");
await writeFile(input, marker);
const runtime = new OmpRuntime({ stateDir: join(root, "state"), cwd });
// Match the worker's Bun/IPC spawn boundary, but deliberately leave this known
// console visible. The supervisor checks the actual Win32 state, not this flag.
const control = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
	cwd, stdin: "ignore", stdout: "ignore", stderr: "pipe", windowsHide: false,
	ipc: () => {}, serialization: "advanced",
});
const watchdog = setTimeout(() => process.exit(2), 85_000);
try {
	const result = await runtime.execute({
		tool: "read", params: { path: `${input}:raw` },
		target: {
			requestId: crypto.randomUUID(), sessionId: "console-proof-session", contextId: "console-proof-context", bindingRevision: 1,
			device: { id: "console-proof-device", name: "Console regression fixture", platform: "win32", arch: process.arch },
		},
	});
	if (result.isError || !result.content.some(block => block.type === "text" && block.text.includes(marker))) throw new Error(`Native read failed: ${JSON.stringify(result)}`);
	await writeFile(join(root, "ready.tmp"), JSON.stringify({ parentPid: process.pid, controlPid: control.pid, completedRead: true }));
	await rename(join(root, "ready.tmp"), join(root, "ready.json"));
	// Both children remain alive while the supervisor attaches to their consoles.
	// Its Job Object owns the entire tree even if this fixture crashes or times out.
	while (!(await Bun.file(join(root, "stop")).exists())) await Bun.sleep(50);
} catch (error) {
	await writeFile(join(root, "failure.txt"), error instanceof Error ? error.stack ?? error.message : String(error));
	process.exitCode = 1;
} finally {
	try { await runtime.close(); }
	finally {
		control.kill("SIGKILL");
		await control.exited;
		clearTimeout(watchdog);
	}
}
