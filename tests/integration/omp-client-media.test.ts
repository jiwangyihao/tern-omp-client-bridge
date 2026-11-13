// SPDX-License-Identifier: MPL-2.0
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage, createAgentSession, ModelRegistry, SessionManager, Settings, SqliteAuthCredentialStore } from "@oh-my-pi/pi-coding-agent";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { readArgsCollapseIntoGroup } from "@oh-my-pi/pi-tui/chat/read-tool-group";
import { readMediaPath } from "@oh-my-pi/pi-tui/native/blobs";
import type { DescribeContext, NativeChild, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { initThemeSync } from "@oh-my-pi/pi-tui/theme";
import type { BrokerApi } from "../../src/api.ts";
import { installClientBridge } from "../../src/omp/extension.ts";
import type { ToolResult } from "../../src/protocol.ts";

// OMP collapses `client://` reads into its read group and shows a grouped read's
// image beneath the assistant message: by `details.mediaPath`, on the agent host,
// when the surface supports `media`. That path exists only on the client device,
// so Tern showed "Not found <path>". Brokers before 0.5.0-beta.12 still return
// it; the result OMP receives from the Bridge must not.
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const clientPath = "/tmp/signout-dlg.png";
const target = { requestId: "media-request", sessionId: "media-session", contextId: "media-context", bindingRevision: 1, device: { id: "client_fixture", name: "Other device", platform: "win32", arch: "x64" } };
const brokerResult: ToolResult = {
	content: [{ type: "text", text: "Read image file [image/png]" }, { type: "image", data: png, mimeType: "image/png" }],
	details: { fileSize: 68, mediaPath: clientPath, meta: { source: { type: "path", value: `client://${clientPath}` } }, clientBridge: { target } },
};

function nodes(child: NativeChild, cx: DescribeContext): NativeNode[] {
	if (!("k" in child)) {
		const described = child.describe?.(cx);
		return described ? nodes(described, cx) : [];
	}
	return [child, ...(child.c ?? []).flatMap(item => nodes(item, cx))];
}

test("a client image read shows its returned bytes in OMP's grouped read, even from an older broker", async () => {
	const root = await mkdtemp(join(tmpdir(), "bridge-client-media-"));
	const database = new Database(":memory:");
	const settings = await Settings.init({ cwd: root, agentDir: join(root, "agent"), inMemory: true, overrides: { "tools.approval": { read: "allow" } } });
	const manager = SessionManager.inMemory(root);
	const auth = new AuthStorage(new SqliteAuthCredentialStore(database));
	const models = new ModelRegistry(auth, join(root, "models.yml"), { ignoreLocalModelConfig: true, cacheDbPath: join(root, "models.db"), settings });
	const unused = (): never => { throw new Error("Unexpected broker call in client media fixture"); };
	const invocations: unknown[] = [];
	const broker: BrokerApi = {
		state: unused, claimIntent: unused, finishIntent: unused,
		invoke: async (_sessionId, _contextId, tool, params) => { invocations.push({ tool, params }); return structuredClone(brokerResult); },
		openDraft: () => ({ update() {}, close() {} }),
		watch: () => () => {},
		closeContext: async () => {},
		close() {},
	};
	let created: Awaited<ReturnType<typeof createAgentSession>> | undefined;
	try {
		created = await createAgentSession({ cwd: root, agentDir: join(root, "agent"), settings, sessionManager: manager,
			authStorage: auth, modelRegistry: models, bindProcessState: false, enableLsp: false, enableIrc: false,
			skipPythonPreflight: true, disableExtensionDiscovery: true, extensions: [api => installClientBridge(api, broker)],
			skills: [], toolNames: ["read"],
		});
		const session = created.session;
		const runner = session.extensionRunner;
		if (!runner) throw new Error("Native extension runner missing");
		const errors: string[] = [];
		runner.onError(error => errors.push(error.error));
		const fixtureOnly = (): never => { throw new Error("Unexpected model/UI action in client media fixture"); };
		runner.initialize({
			sendMessage: fixtureOnly, sendUserMessage: fixtureOnly, appendEntry: fixtureOnly, setLabel: fixtureOnly,
			getActiveTools: () => session.getEnabledToolNames(), getAllTools: () => session.getAllToolInfos(), setActiveTools: fixtureOnly,
			getCommands: () => [], setModel: fixtureOnly, getThinkingLevel: () => "off", setThinkingLevel: fixtureOnly,
			getSessionName: () => undefined, setSessionName: fixtureOnly,
		}, { getModel: () => undefined, isIdle: () => true, abort: fixtureOnly, hasPendingMessages: () => false,
			shutdown: fixtureOnly, getContextUsage: () => undefined, compact: fixtureOnly, getSystemPrompt: () => [] });
		await runner.emit({ type: "session_start" });
		await runner.emit({ type: "session_branch", reason: "branch", previousSessionFile: undefined });
		expect(errors).toEqual([]);
		const read = session.getToolByName("read");
		if (!read) throw new Error("Native read missing");
		const args = { path: `client://${clientPath}` };
		const result = await read.execute(crypto.randomUUID(), args);
		expect(invocations).toHaveLength(1);
		expect(result.details).toMatchObject({ clientBridge: { target }, meta: { source: { value: `client://${clientPath}` } } });
		expect(result.details).not.toHaveProperty("mediaPath");

		// What OMP's event controller does with a grouped read's result.
		expect(readArgsCollapseIntoGroup(args)).toBe(true);
		initThemeSync();
		const message = new AssistantMessageComponent({
			role: "assistant", api: "fixture", provider: "fixture", model: "fixture", stopReason: "toolUse", timestamp: 1,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			content: [{ type: "toolCall", id: "media-call", name: "read", arguments: args }],
		});
		message.setToolResultImages("media-call", result.content.filter(item => item.type === "image"), readMediaPath(result.details));
		const cx: DescribeContext = { cols: 100, reduceMotion: true, dark: true, supports: () => true, feature: () => true };
		const described = nodes(message.describe(cx), cx);
		expect(described.filter(node => node.k === "media")).toEqual([]);
		expect(described.filter(node => node.k === "image")).toHaveLength(1);
	} finally {
		await created?.session.dispose();
		database.close();
		await rm(root, { recursive: true, force: true });
	}
}, 90000);
