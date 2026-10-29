// SPDX-License-Identifier: MPL-2.0
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolName, ToolParameters, ToolResult } from "../../src/protocol.ts";
import type { RuntimeEnvironment } from "../../src/runtime/environment.ts";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

interface Fixture {
	root: string;
	agentDir: string;
	cwd: string;
	config: string;
	overlayPath?: string;
}

async function fixture(global: Record<string, unknown>, project?: Record<string, unknown>, overlay?: Record<string, unknown>): Promise<Fixture> {
	const root = await mkdtemp(join(tmpdir(), "native-policy-"));
	roots.push(root);
	const agentDir = join(root, "client-agent");
	const cwd = join(root, "client-workspace");
	await mkdir(agentDir);
	await mkdir(cwd);
	const config = Bun.YAML.stringify(global);
	await writeFile(join(agentDir, "config.yml"), config);
	await writeFile(join(agentDir, "keys.json"), '{"fixture":"unchanged-local-key"}\n');
	if (project) {
		await mkdir(join(cwd, ".omp"));
		await writeFile(join(cwd, ".omp", "config.yml"), Bun.YAML.stringify(project));
	}
	const overlayPath = overlay ? join(root, "client-overlay.yml") : undefined;
	if (overlayPath) await writeFile(overlayPath, Bun.YAML.stringify(overlay));
	return { root, agentDir, cwd, config, overlayPath };
}

type Outcome = { result?: ToolResult; error?: string };

// A fresh client process resolves the native profile/config paths before the
// runtime isolates its workers. Never change the test runner's SDK singleton,
// the developer's HOME/config, or any live desktop/browser state.
async function invoke(local: Fixture, calls: Array<{ tool: ToolName; params: ToolParameters }>, choice?: string | null): Promise<{ outcomes: Outcome[]; prompts: string[]; environment: RuntimeEnvironment }> {
	const env: Record<string, string | undefined> = { ...process.env };
	for (const name of Object.keys(env)) if (name.startsWith("PI_") || name.startsWith("OMP_") || name.startsWith("NODE_CHANNEL_")) delete env[name];
	env.PI_CODING_AGENT_DIR = local.agentDir;
	if (local.overlayPath) env.PI_CONFIG_FILES = local.overlayPath;
	const source = `
		import { OmpRuntime, inspectRuntimeEnvironment } from ${JSON.stringify(new URL("../../src/runtime/index.ts", import.meta.url).href)};
		const prompts = [];
		const choice = ${JSON.stringify(choice ?? null)};
		const runtime = new OmpRuntime({ stateDir: ${JSON.stringify(join(local.root, "state"))}, cwd: ${JSON.stringify(local.cwd)},
			${choice === undefined ? "" : "onInteraction: async request => { prompts.push(request.message); return { choice }; },"}
		});
		const outcomes = [];
		try {
			for (const call of ${JSON.stringify(calls)}) {
				try {
					const result = await runtime.execute({ ...call, target: { requestId: crypto.randomUUID(), sessionId: "policy-session", contextId: "policy-context", bindingRevision: 1,
						device: { id: "local-client", name: "Local client", platform: process.platform, arch: process.arch } } });
					outcomes.push({ result });
				} catch (error) { outcomes.push({ error: String(error) }); }
			}
			const environment = await inspectRuntimeEnvironment(${JSON.stringify(local.cwd)});
			console.log(JSON.stringify({ outcomes, prompts, environment }));
		} finally { await runtime.close(); }
	`;
	const child = Bun.spawn([process.execPath, "--eval", source], { cwd: local.cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	try {
		const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		expect({ exit, stderr: exit === 0 ? "" : stderr }).toEqual({ exit: 0, stderr: "" });
		return JSON.parse(stdout);
	} finally { child.kill(); }
}

function text(outcome: Outcome | undefined): string {
	return outcome?.error ?? outcome?.result?.content.filter(block => block.type === "text").map(block => block.text).join("\n") ?? "";
}

test("client-global native denial and prompt policies apply without grants and never rewrite client configuration", async () => {
	const local = await fixture({ tools: { approvalMode: "yolo", approval: { bash: "deny", write: "prompt", eval: "allow" } }, eval: { js: true } });
	const path = join(local.cwd, "must-not-write.txt");
	const result = await invoke(local, [
		{ tool: "bash", params: { command: `printf forbidden > ${JSON.stringify(path)}` } },
		{ tool: "write", params: { path, content: "forbidden" } },
		{ tool: "eval", params: { language: "js", code: 'await tool.bash({command:"printf nested-forbidden"})' } },
	]);
	expect(text(result.outcomes[0])).toMatch(/denied|deny/i);
	expect(text(result.outcomes[1])).toContain("permission denied");
	expect(result.outcomes[2]?.result?.isError).toBe(true);
	expect(text(result.outcomes[2])).toMatch(/denied|deny/i);
	expect(await Bun.file(path).exists()).toBe(false);
	expect(result.prompts).toEqual([]);
	expect(await readFile(join(local.agentDir, "config.yml"), "utf8")).toBe(local.config);
	expect(await readFile(join(local.agentDir, "keys.json"), "utf8")).toBe('{"fixture":"unchanged-local-key"}\n');
	expect((await readdir(local.agentDir)).sort()).toEqual(["config.yml", "keys.json"]);
}, 90_000);

test("native approval mode prompts once for Eval and affirmative client approval authorizes the operation", async () => {
	const local = await fixture({ tools: { approvalMode: "always-ask" }, eval: { js: true } });
	const calls = [{ tool: "eval" as const, params: { language: "js" as const, code: 'console.log("native-approved")' } }];
	const denied = await invoke(local, calls, "no");
	expect(text(denied.outcomes[0])).toContain("permission denied");
	expect(denied.prompts).toHaveLength(1);
	const approved = await invoke(local, calls, "yes");
	expect(approved.outcomes[0]?.result?.isError).not.toBe(true);
	expect(text(approved.outcomes[0])).toContain("native-approved");
	expect(approved.prompts).toHaveLength(1);
}, 120_000);

test("native project and explicit client overlays retain precedence over global policy", async () => {
	const global = { tools: { approvalMode: "yolo", approval: { bash: "deny" } } };
	const project = { tools: { approval: { bash: "allow" } } };
	const call = { tool: "bash" as const, params: { command: "printf project-policy" } };
	const projectClient = await fixture(global, project);
	expect(text((await invoke(projectClient, [call])).outcomes[0])).toContain("project-policy");
	const overlayClient = await fixture(global, project, { tools: { approval: { bash: "deny" } } });
	expect(text((await invoke(overlayClient, [call])).outcomes[0])).toMatch(/denied|deny/i);
}, 120_000);

test("native disabled preludes stay unavailable and enabled denied preludes never reach a backend", async () => {
	const disabled = await fixture({ tools: { approvalMode: "yolo" }, eval: { js: true }, computer: { enabled: false }, browser: { enabled: false } });
	const absent = await invoke(disabled, [{ tool: "eval", params: { language: "js", code: 'console.log(typeof computer + ":" + typeof browser)' } }]);
	expect(text(absent.outcomes[0])).toContain("undefined:undefined");
	expect(absent.environment.computer.availability).toBe("disabled");
	expect(absent.environment.browser.availability).toBe("disabled");
	const enabled = await fixture({ tools: { approvalMode: "yolo", approval: { computer: "deny", browser: "deny" } }, eval: { js: true }, computer: { enabled: true }, browser: { enabled: true } });
	const denied = await invoke(enabled, [
		{ tool: "eval", params: { language: "js", code: "await computer.capabilities()" } },
		{ tool: "eval", params: { language: "js", code: "await browser.tabs()" } },
	]);
	for (const outcome of denied.outcomes) {
		expect(outcome.result?.isError).toBe(true);
		expect(text(outcome)).toMatch(/denied|deny/i);
	}
	expect(denied.environment.computer.availability).toBe("not-probed");
	expect(denied.environment.browser.availability).toBe("not-probed");
}, 120_000);
