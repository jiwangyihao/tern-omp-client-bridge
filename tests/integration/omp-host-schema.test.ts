// SPDX-License-Identifier: MPL-2.0
import { test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const FileChecks = z.object({ defaultAllowed: z.literal(true), clientAllowed: z.literal(true), namedAllowed: z.literal(true),
	invalidIdRejected: z.literal(true), invalidNativeInputRejected: z.literal(true) });
const ExecutionChecks = FileChecks.extend({ agentAllowed: z.literal(true), invalidTargetRejected: z.literal(true), missingNativeRequiredRejected: z.literal(true) });
const ResultSchema = z.object({ eval: ExecutionChecks, bash: ExecutionChecks, read: FileChecks, write: FileChecks, edit: FileChecks, grep: FileChecks, glob: FileChecks });

test("bundled OMP host composes clientId with all seven native validators", async () => {
	// Keep the SDK's HOME-relative configuration on the same volume on native Windows.
	const root = await mkdtemp(join(homedir(), ".bridge-host-schema-"));
	const resultPath = join(root, "result.json");
	const environment: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.startsWith("PI_") && !key.startsWith("OMP_") && !/(?:KEY|TOKEN|SECRET)$/i.test(key)) environment[key] = value;
	}
	Object.assign(environment, {
		PI_CONFIG_DIR: relative(homedir(), join(root, "config")), PI_CODING_AGENT_DIR: join(root, "agent"),
		BRIDGE_HOST_PROBE_STATE: join(root, "bridge"), BRIDGE_HOST_PROBE_RESULT: resultPath,
		OPENAI_API_KEY: "synthetic-not-used", OTEL_SDK_DISABLED: "true",
	});
	const cli = fileURLToPath(new URL("../../node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js", import.meta.url));
	const fixture = fileURLToPath(new URL("../fixtures/host-parameters-probe.ts", import.meta.url));
	const command = process.env.BRIDGE_TEST_OMP ? [process.env.BRIDGE_TEST_OMP] : [process.execPath, cli];
	const child = Bun.spawn([...command, "--mode", "rpc", "--model", "openai/gpt-4o-mini", "--no-session", "--no-skills", "--no-extensions", "--no-rules", "--no-lsp", "--no-title", "-e", fixture], {
		cwd: root, env: environment, stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 40000,
	});
	try {
		const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		if (code !== 0) throw new Error(`Isolated host exited ${code}: ${stderr}\n${stdout}`);
		ResultSchema.parse(JSON.parse(await readFile(resultPath, "utf8")));
	} finally {
		if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; }
		await rm(root, { recursive: true, force: true });
	}
}, 50000);
