// SPDX-License-Identifier: MPL-2.0
// Runs only in the compiled host spawned by acceptance.py. Forward registrations
// to its real runner; inspect metadata without executing tools or submitting input.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { findScopedSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionAPI, ExtensionHandler, ToolCallEvent, ToolCallEventResult, ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { loadLegacyPiModule } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat";

export default async function verifyActiveBridge(api: ExtensionAPI): Promise<void> {
	const root = process.env.BRIDGE_ACCEPTANCE_ROOT;
	assert.ok(root && root === process.cwd(), "probe requires its isolated working directory");
	const tools = new Map<string, ToolDefinition>();
	let gate: ExtensionHandler<ToolCallEvent, ToolCallEventResult> | undefined;
	const loader = process.env.BRIDGE_ACCEPTANCE_LOADER ?? join(root, "agent/extensions/tern-omp-client-bridge/index.ts");
	const loaded = await loadLegacyPiModule(loader) as { default: (api: ExtensionAPI) => unknown };
	await loaded.default(new Proxy(api, {
		get(target, key, receiver) {
			if (key === "on") return (event: string, handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>) => {
				if (event === "tool_call") gate = handler;
				return Reflect.apply(target.on, target, [event, handler]);
			};
			if (key !== "registerTool") return Reflect.get(target, key, receiver);
			return (definition: ToolDefinition) => {
				target.registerTool(definition);
				assert.ok(!tools.has(definition.name), `duplicate override ${definition.name}`);
				tools.set(definition.name, definition);
			};
		},
	}));
	api.on("input", () => {
		writeFileSync(join(root, "unexpected-submit"), "input received");
		return { handled: true }; // Fail closed: even a regression must not call a model.
	});
	api.on("session_start", async (_event, ctx) => {
		try {
			assert.equal(ctx.mode, "tui");
			assert.equal(ctx.hasUI, true);
			assert.ok(ctx.ui.supportsEditor);
			assert.ok(findScopedSettings(ctx.cwd), "missing native session Settings");
			const path = "client:///fixture";
			const inputs: Record<string, Record<string, unknown>> = {
				eval: { language: "js", code: "1" }, bash: { command: "printf fixture" }, read: { path },
				write: { path, content: "fixture" }, edit: { input: "fixture", path, edits: [], old_string: "x", new_string: "y" },
				glob: { path }, grep: { path, pattern: "fixture" },
			};
			assert.deepEqual([...tools.keys()].sort(), Object.keys(inputs).sort());
			for (const [name, tool] of tools) {
				const schema = tool.parameters;
				assert.ok(typeof schema === "function", `${name}: not the host validator`);
				const input = inputs[name]!;
				const execution = name === "eval" || name === "bash";
				const client = execution ? { ...input, target: "client" } : input;
				assert.ok(schema.allows(input), `${name}: lost native input`);
				assert.ok(schema.allows({ ...client, clientId: "client_A" }), `${name}: named client rejected`);
				assert.ok(!schema.allows({ ...client, clientId: "not an id" }), `${name}: invalid clientId accepted`);
				if (execution) assert.ok(!schema.allows({ ...input, target: "device" }), `${name}: invalid target accepted`);
				assert.equal(typeof tool.renderCall, "function", `${name}: missing OMP 19 call renderer`);
				assert.equal(typeof tool.renderResult, "function", `${name}: missing OMP 19 result renderer`);
				assert.ok("mergeCallAndResult" in tool && tool.mergeCallAndResult === true, `${name}: lost native merged presentation`);
			}
			// Exercise the registered decision and its cache keys without reading
			// a file, answering an approval, or creating a remembered grant.
			const read = tools.get("read");
			assert.ok(read && "approvalCacheTargets" in read && typeof read.approvalCacheTargets === "function" && typeof read.approval === "function");
			const hostPath = join(root, "agent", "config.yml");
			assert.deepEqual(read.approvalCacheTargets({ path: hostPath }), [hostPath]);
			const onClient = { path: `client://${hostPath}`, clientId: "client_A" };
			assert.equal(read.approvalCacheTargets(onClient), undefined, "client file inherited a host file/folder grant key");
			const decision = read.approval(onClient);
			assert.ok(typeof decision === "object" && decision.tier === "read" && decision.policy === "prompt",
				"cached approval mode must prompt for a client read without a host grant");
			const approval = tools.get("bash")?.approval;
			assert.ok(typeof approval === "function");
			const denied = approval({ command: "bridge-policy-probe fixture" });
			assert.ok(typeof denied === "object" && denied.policy === "deny" && denied.reason?.includes("bridge-policy-probe"), "scoped host Bash deny was lost");
			assert.ok(gate, "missing pre-dispatch gate");
			const decide = (command: string, target: string) => gate!({ type: "tool_call", toolName: "bash", toolCallId: "route-probe", input: { command, target } }, ctx);
			assert.equal((await decide("grep --help", "client"))?.block, true, "client tool-command line could run on the host");
			assert.equal((await decide("resolve --help", "client"))?.block, true, "client special command could run on the host");
			assert.equal((await decide("grep --help", "agent"))?.block, undefined, "agent command was incorrectly blocked");
			assert.equal((await decide("printf fixture", "client"))?.block, undefined, "ordinary client shell command was incorrectly blocked");
			writeFileSync(join(root, "activation.json"), JSON.stringify({ tools: [...tools.keys()].sort(), scopedDeny: true, clientBashGuard: true }), { flag: "wx" });
		} catch (error) {
			writeFileSync(join(root, "activation.json"), JSON.stringify({ error: String(error) }), { flag: "wx" });
		}
	});
}
