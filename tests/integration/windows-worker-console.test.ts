// SPDX-License-Identifier: MPL-2.0
import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";

const run = promisify(execFile);
const Observation = z.object({ pid: z.number().int().positive(), attached: z.boolean(), window: z.string(), visible: z.boolean(), error: z.number().int() });
const Report = z.object({ parent: Observation, control: Observation, worker: Observation, completedRead: z.literal(true) });

test.skipIf(process.platform !== "win32")("a detached client executes native tools without exposing its worker console", async () => {
	const root = await mkdtemp(join(tmpdir(), "bridge-console-proof-"));
	try {
		const { stdout } = await run("powershell.exe", [
			"-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
			fileURLToPath(new URL("../fixtures/windows-worker-console.ps1", import.meta.url)),
			"-Bun", process.execPath,
			"-Fixture", fileURLToPath(new URL("../fixtures/windows-worker-console-parent.ts", import.meta.url)),
			"-Root", root,
		], { windowsHide: true, timeout: 100_000, maxBuffer: 128 * 1024 });
		const report = Report.parse(JSON.parse(stdout));
		// A positive control must expose an OS-visible console on this very runner.
		// Never turn an unsupported desktop/session into a vacuous successful test.
		expect(report.control.attached).toBe(true);
		expect(report.control.visible).toBe(true);
		expect(report.parent.attached).toBe(false);
		expect(report.parent.error).toBe(6); // ERROR_INVALID_HANDLE: no console to attach.
		expect(report.worker.pid).not.toBe(report.parent.pid);
		expect(report.worker.pid).not.toBe(report.control.pid);
		expect(report.worker.visible).toBe(false);
		expect(report.completedRead).toBe(true);
	} finally {
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	}
}, 110_000);
