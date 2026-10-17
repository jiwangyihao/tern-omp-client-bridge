// SPDX-License-Identifier: MPL-2.0
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const CheckSchema = z.object({
	defaultAllowed: z.boolean(), agentAllowed: z.boolean(), clientAllowed: z.boolean(),
	invalidTargetRejected: z.boolean(), missingNativeRequiredRejected: z.boolean(), invalidNativeInputRejected: z.boolean(),
});
const ResultSchema = z.object({ eval: CheckSchema, bash: CheckSchema });

test("bundled OMP host retains native validation while accepting only the two execution targets", async () => {
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
	const child = Bun.spawn([process.execPath, cli, "--mode", "rpc", "--model", "openai/gpt-4o-mini", "--no-session", "--no-skills", "--no-extensions", "--no-rules", "--no-lsp", "--no-title", "-e", fixture], {
		cwd: root, env: environment, stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 40000,
	});
	try {
		const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		if (code !== 0) throw new Error(`Isolated host exited ${code}: ${stderr}\n${stdout}`);
		const result = ResultSchema.parse(JSON.parse(await readFile(resultPath, "utf8")));
		for (const tool of [result.eval, result.bash]) {
			expect(tool).toEqual({ defaultAllowed: true, agentAllowed: true, clientAllowed: true, invalidTargetRejected: true, missingNativeRequiredRejected: true, invalidNativeInputRejected: true });
		}
	} finally {
		if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; }
		await rm(root, { recursive: true, force: true });
	}
}, 50000);
