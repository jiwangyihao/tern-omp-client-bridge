// SPDX-License-Identifier: MPL-2.0
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage, createAgentSession, ModelRegistry, SessionManager, Settings, SqliteAuthCredentialStore } from "@oh-my-pi/pi-coding-agent";
import { BrokerClient } from "../../src/broker-client.ts";
import { installClientBridge } from "../../src/omp/extension.ts";

// Real native tools, no Client service, no model calls or production filesystem.
test("agent-host tools survive a conversation boundary without a Client policy, while native denials remain enforced", async () => {
 const root = await mkdtemp(join(tmpdir(), "bridge-agent-local-"));
 const database = new Database(":memory:");
 const settings = await Settings.init({ cwd: root, agentDir: join(root, "agent"), inMemory: true, overrides: {
  "tools.approval": { read: "allow", write: "allow", bash: "allow", eval: "allow" },
  "bash.patterns": [{ match: "printf blocked*", approval: "deny" }],
  "eval.py": false, "eval.js": true, "eval.autoProvision": false,
 } });
 const manager = SessionManager.inMemory(root);
 const auth = new AuthStorage(new SqliteAuthCredentialStore(database));
 const models = new ModelRegistry(auth, join(root, "models.yml"), { ignoreLocalModelConfig: true, cacheDbPath: join(root, "models.db"), settings });
 const broker = new BrokerClient({ stateDir: join(root, "unavailable-broker") });
 let created: Awaited<ReturnType<typeof createAgentSession>> | undefined;
 try {
  created = await createAgentSession({ cwd: root, agentDir: join(root, "agent"), settings, sessionManager: manager,
   authStorage: auth, modelRegistry: models, bindProcessState: false, enableLsp: false, enableIrc: false,
   skipPythonPreflight: true, disableExtensionDiscovery: true, extensions: [api => installClientBridge(api, broker)],
   skills: [], toolNames: ["read", "write", "bash", "eval"],
  });
  const session = created.session;
  const runner = session.extensionRunner;
  if (!runner) throw new Error("Native extension runner missing");
  const lifecycleErrors: string[] = [];
  runner.onError(error => lifecycleErrors.push(error.error));
  const unused = (): never => { throw new Error("Unexpected model/UI action in agent-local fixture"); };
  runner.initialize({
   sendMessage: unused, sendUserMessage: unused, appendEntry: unused, setLabel: unused,
   getActiveTools: () => session.getEnabledToolNames(), getAllTools: () => session.getAllToolInfos(), setActiveTools: unused,
   getCommands: () => [], setModel: unused, getThinkingLevel: () => "off", setThinkingLevel: unused,
   getSessionName: () => undefined, setSessionName: unused,
  }, { getModel: () => undefined, isIdle: () => true, abort: unused, hasPendingMessages: () => false,
   shutdown: unused, getContextUsage: () => undefined, compact: unused, getSystemPrompt: () => [] });
  await runner.emit({ type: "session_start" });
  if (!runner.getRegisteredTool("read")) throw new Error(`Bridge override missing: ${lifecycleErrors.join("; ")}`);
  const execute = async (name: string, args: Record<string, unknown>) => {
   const tool = session.getToolByName(name);
   if (!tool) throw new Error(`Native tool missing: ${name}`);
   return tool.execute(crypto.randomUUID(), args);
  };
  const text = (result: Awaited<ReturnType<typeof execute>>) => result.content.filter(item => item.type === "text").map(item => item.text).join("\n");
  await writeFile(join(root, "input.txt"), "agent-owned-before-boundary\n");
  expect(text(await execute("read", { path: join(root, "input.txt") + ":raw" }))).toContain("agent-owned-before-boundary");
  // Exercise the interval before the native branch lifecycle has reached Bridge.
  await manager.newSession();
  expect(text(await execute("read", { path: join(root, "input.txt") + ":raw" }))).toContain("agent-owned-before-boundary");
  await execute("write", { path: join(root, "output.txt"), content: "agent-owned-after-boundary" });
  expect(await readFile(join(root, "output.txt"), "utf8")).toBe("agent-owned-after-boundary");
  expect(text(await execute("bash", { command: "printf native-agent-default" }))).toContain("native-agent-default");
  expect(text(await execute("bash", { target: "agent", command: "printf native-agent-explicit" }))).toContain("native-agent-explicit");
  expect(text(await execute("eval", { language: "js", code: "globalThis.agentOnly = 40; print(agentOnly)" }))).toContain("40");
  expect(text(await execute("eval", { target: "agent", language: "js", code: "print(agentOnly + 2)" }))).toContain("42");
  await expect(execute("bash", { command: "printf blocked" })).rejects.toThrow('Tool "bash" is blocked by tool policy.');
  await expect(execute("read", { path: "client:///not-accessed" })).rejects.toThrow("scoped Settings");
  await runner.emit({ type: "session_branch", reason: "branch", previousSessionFile: undefined });
  const blocked = await execute("read", { path: "client:///not-accessed" }).then(() => "unexpected-success", error => String(error));
  expect(blocked).not.toBe("unexpected-success");
  expect(blocked).not.toContain("scoped Settings");
 } finally {
  await created?.session.dispose();
  broker.close(); database.close();
  await rm(root, { recursive: true, force: true });
 }
}, 90000);
