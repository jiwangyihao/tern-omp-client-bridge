// SPDX-License-Identifier: MPL-2.0
// Offline acceptance: real AgentSession.prompt + shipped Bridge, synthetic broker/stream only.
// Run with Bun; explicit Recode modules are loaded unchanged, never copied into this repo.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { AssistantMessage, Context, Model } from "@oh-my-pi/pi-ai";
import type { AnthropicMessageParam } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { BrokerApi, ServerState } from "../src/api.ts";

const { values } = parseArgs({ args: Bun.argv.slice(2), options: {
	"recode-thread": { type: "string" }, "recode-models": { type: "string" },
	model: { type: "string", default: "claude-opus-5-5" }, report: { type: "string" },
	diagnostic: { type: "boolean", default: false }, "controlled-descriptors": { type: "boolean", default: false },
} });
const threadPath = values["recode-thread"] ?? process.env.BRIDGE_RECODE_THREAD_MODULE;
const modelsPath = values["recode-models"] ?? process.env.BRIDGE_RECODE_MODELS_MODULE;
assert(threadPath && modelsPath, "Pass --recode-thread and --recode-models (absolute installed module paths), or BRIDGE_RECODE_THREAD_MODULE/BRIDGE_RECODE_MODELS_MODULE");

// Install guards BEFORE loading the SDK/provider module graphs. No credential discovery,
// model transport, historical operation, or production broker belongs in this fixture.
// Intentional module-loading-boundary test: static SDK imports would execute before these guards.
let blockedNetworkCalls = 0;
let blockedPreconnects = 0;
const forbidNetwork = (): never => { blockedNetworkCalls++; throw new Error("Binding smoke prohibits network I/O"); };
globalThis.fetch = Object.assign(forbidNetwork, { preconnect: () => { blockedPreconnects++; } });
Socket.prototype.connect = forbidNetwork;
const { Database } = await import("bun:sqlite");
const { AuthStorage, createAgentSession, ModelRegistry, SessionManager, Settings, SqliteAuthCredentialStore } = await import("@oh-my-pi/pi-coding-agent");
const { AssistantMessageEventStream } = await import("@oh-my-pi/pi-ai/utils/event-stream");
const { convertAnthropicMessages } = await import("@oh-my-pi/pi-ai/providers/anthropic");
const { applyGlyphCodec } = await import("@oh-my-pi/pi-ai/utils/glyph-codec");
const { installClientBridge, bindingDescription } = await import("../src/omp/extension.ts");

interface ThreadTurn {
	prepare(payload: unknown, context: Context, model?: Model): unknown;
	startAttempt(): void;
	onSseEvent(event: { event: string; data: string }): void;
	commit(response: AssistantMessage, safety?: { signal?: AbortSignal; captureFailed?: boolean }): boolean;
	abort(): void;
}
interface Identity { credentialGeneration: string; accountId: string; model: string; sessionId: string }
interface ThreadOwner { begin(identity: Identity, observer?: (event: Readonly<Record<string, unknown>>) => void): ThreadTurn }
const modulePins = await Promise.all([
	{ role: "recodeThread", path: resolve(threadPath), packageName: "omp-codex-sg" },
	{ role: "recodeModels", path: resolve(modelsPath), packageName: "omp-codex-sg" },
	{ role: "hostAiConverter", path: fileURLToPath(import.meta.resolve("@oh-my-pi/pi-ai/providers/anthropic")), packageName: "@oh-my-pi/pi-ai" },
	{ role: "recodeAiConverter", path: Bun.resolveSync("@oh-my-pi/pi-ai/providers/anthropic", dirname(resolve(threadPath))), packageName: "@oh-my-pi/pi-ai" },
	{ role: "hostSdk", path: fileURLToPath(import.meta.resolve("@oh-my-pi/pi-coding-agent")), packageName: "@oh-my-pi/pi-coding-agent" },
].map(async module => ({ ...module, sha256: createHash("sha256").update(await readFile(module.path)).digest("hex"),
	package: await packageInfo(module.path, module.packageName) })));
console.log(JSON.stringify({ event: "binding-smoke-module-pins", modules: modulePins }));
const threadModule: { RecodeClaudeThreadState: new () => ThreadOwner } = await import(pathToFileURL(resolve(threadPath)).href);
const modelModule: { getRecodeNativeModel(id: string): Model | undefined } = await import(pathToFileURL(resolve(modelsPath)).href);
assert.equal(typeof threadModule.RecodeClaudeThreadState, "function");
const model = modelModule.getRecodeNativeModel(values.model!);
function isAnthropicModel(candidate: Model | undefined): candidate is Model<"anthropic-messages"> & { contextWindow: number; maxTokens: number } {
	return candidate !== undefined && candidate.api === "anthropic-messages"
		&& (candidate.remoteCompaction?.api === undefined || candidate.remoteCompaction.api === "anthropic-messages")
		&& typeof candidate.contextWindow === "number" && Number.isFinite(candidate.contextWindow) && candidate.contextWindow > 0
		&& typeof candidate.maxTokens === "number" && Number.isFinite(candidate.maxTokens) && candidate.maxTokens > 0;
}
assert(isAnthropicModel(model), "Requested Recode model must use anthropic-messages with compatible compaction API and finite positive context/output limits");
const nativeModel = model;
const ThreadState = threadModule.RecodeClaudeThreadState;
const owner = new ThreadState();
const credentialId = 23; // Explicitly synthetic row identity; no credential store row is read.
const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const toolName = "bridge_fixture_echo";
const toolSchema = { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false };
interface WirePayload {
	model: string;
	system: Context["systemPrompt"];
	tools: Array<{ name: string; description: string; input_schema: typeof toolSchema }>;
	messages: AnthropicMessageParam[];
	stream: boolean;
}
const root = await mkdtemp(join(tmpdir(), "bridge-history-host-smoke-"));
const database = new Database(":memory:");
const failures: string[] = [];
const cases: Array<{ name: string; decision?: string; detail?: string }> = [];
const externalBlockers: Array<{ round: number; reason: string; actual: string }> = [];
interface Fingerprint { digest: string; fields: Record<string, string> }
interface RequestAudit { historyCount: number; historyDigest: string; history: Fingerprint; wire: Fingerprint; contextConfig: Fingerprint; declaredContextConfig: Fingerprint; payloadConfig: Fingerprint; model: Fingerprint }
const captures: Array<{ context: Context; payload: WirePayload; response: AssistantMessage; decision: string; audit: RequestAudit; responseAudit: Fingerprint; externalContextMismatch: boolean }> = [];
let created: CreateAgentSessionResult | undefined;
let preparation: "accept" | "throw" | "throw-and-cancel" | "cancel" = "accept";
let cancelPending: Promise<void> | undefined;
let streamFailure: unknown;
let streamDispatches = 0;
let containedHandlerErrors = 0;
let shallowMessageSnapshots = 0;
let nextReplies = 1;
let executedTools = 0;
let compactions = 0;
let serial = 0;
let expectedFirstDecision = "create";
const states = new Map<string, ServerState>();
const watchers = new Map<string, (state: ServerState) => void>();
const stateFor = (sessionId: string): ServerState => {
	let state = states.get(sessionId);
	if (!state) {
		state = { serverInstance: "synthetic-broker", binding: { sessionId, clientId: null, revision: 0, change: null }, devices: [] };
		states.set(sessionId, state);
	}
	return state;
};
const unexpected = (): never => { throw new Error("Unexpected external/native mutation in offline binding smoke"); };
const broker: BrokerApi = {
	state: async id => stateFor(id), invoke: unexpected, openDraft: unexpected, claimIntent: unexpected,
	finishIntent: unexpected, closeContext: async () => {}, close: () => {},
	watch(id, onState) { watchers.set(id, onState); onState(stateFor(id)); return () => { if (watchers.get(id) === onState) watchers.delete(id); }; },
};
function identity(sessionId: string): Identity {
	return { credentialGeneration: "synthetic-generation", accountId: "synthetic-account", model: nativeModel.id, sessionId };
}
function record(value: unknown): Record<string, unknown> {
	assert(value !== null && typeof value === "object" && !Array.isArray(value), "Expected object from unmodified thread module");
	return value as Record<string, unknown>;
}
function decision(value: unknown): string {
	const type = record(record(value).thread).type;
	assert(type === "create" || type === "continue", "Missing native thread decision");
	return type;
}
// Diagnostic-only fingerprints mirror Recode's documented canonicalization. They
// never replace messages, payloads, signatures or schema objects passed to it.
function canonical(value: unknown): string {
	return JSON.stringify(value, (_key, entry: unknown) => entry !== null && typeof entry === "object" && !Array.isArray(entry)
		? Object.fromEntries(Object.keys(entry).sort().map(key => [key, Reflect.get(entry, key)])) : entry) ?? "null";
}
function fingerprint(value: unknown): Fingerprint {
	const serialized = canonical(value);
	const fields: Record<string, string> = {};
	function visit(item: unknown, path: string): void {
		fields[path] = createHash("sha256").update(canonical(item)).digest("hex");
		if (Array.isArray(item)) {
			fields[`${path}.length`] = createHash("sha256").update(String(item.length)).digest("hex");
			item.forEach((child, index) => visit(child, `${path}[${index}]`));
		} else if (item !== null && typeof item === "object") {
			for (const key of Object.keys(item)) visit(Reflect.get(item, key), `${path}.${key}`);
		}
	}
	visit(JSON.parse(serialized), "$analysis");
	return { digest: createHash("sha256").update(serialized).digest("hex"), fields };
}
function differences(expected: Fingerprint, actual: Fingerprint) {
	const paths = [...new Set([...Object.keys(expected.fields), ...Object.keys(actual.fields)])]
		.filter(path => expected.fields[path] !== actual.fields[path]);
	return { expectedDigest: expected.digest, actualDigest: actual.digest, mismatchCount: paths.length,
		fields: paths.slice(0, 60).map(path => ({ path, expectedHash: expected.fields[path] ?? null, actualHash: actual.fields[path] ?? null })) };
}
function replayMessage(message: Context["messages"][number] | undefined) {
	if (!message) return undefined;
	const { timestamp: _timestamp, ...rest } = message;
	if (message.role !== "assistant") return rest;
	const { usage: _usage, duration: _duration, ttft: _ttft, completedAt: _completedAt, contextSnapshot: _contextSnapshot,
		...replay } = message;
	const { timestamp: _assistantTimestamp, ...withoutTimestamp } = replay;
	return withoutTimestamp;
}
// Diagnostic/counterfactual comparison only; never replaces the raw provider context.
function declaredTools(tools: Context["tools"]): Context["tools"] {
	return tools?.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters,
		strict: tool.strict, deferLoading: tool.deferLoading, customFormat: tool.customFormat,
		customWireName: tool.customWireName, native: tool.native, examples: tool.examples }));
}
function requestAudit(context: Context, payload: WirePayload, requestedModel: Model): RequestAudit {
	const replay = context.messages.map(replayMessage);
	const digest = createHash("sha256");
	for (const message of replay) digest.update(canonical(message)).update("\0");
	const { messages: _messages, ...configuration } = payload;
	return { historyCount: context.messages.length, historyDigest: digest.digest("hex"), history: fingerprint(replay),
		wire: fingerprint(payload.messages), contextConfig: fingerprint({ systemPrompt: context.systemPrompt, tools: context.tools, inactiveTools: context.inactiveTools }),
		declaredContextConfig: fingerprint({ systemPrompt: context.systemPrompt, tools: declaredTools(context.tools), inactiveTools: declaredTools(context.inactiveTools) }),
		payloadConfig: fingerprint(configuration), model: fingerprint(requestedModel) };
}
function snapshotContext(context: Context): Context {
	// Match ExtensionRunner.emitContext's message-copy contract: preserve complete
	// messages, falling back to an array copy for opaque non-cloneable metadata.
	// Negative cases replace records/arrays; they never mutate borrowed metadata.
	let messages: Context["messages"];
	try { messages = structuredClone(context.messages); }
	catch {
		shallowMessageSnapshots++;
		messages = [...context.messages];
	}
	// Tool schemas contain executable validators. Retain those original schema
	// objects while isolating descriptor arrays/records; do not JSON-normalize or
	// omit tools/inactiveTools, which Recode includes in its context fingerprint.
	return { ...context, messages, systemPrompt: context.systemPrompt?.slice(),
		tools: context.tools?.map(tool => ({ ...tool })),
		inactiveTools: context.inactiveTools?.map(tool => ({ ...tool })) };
}
function wire(context: Context) {
	const encoded = nativeModel.requiresGlyphTokenization ? applyGlyphCodec(context).context : context;
	return { model: nativeModel.id, system: context.systemPrompt ?? [],
		tools: [{ name: toolName, description: "Synthetic fixture only", input_schema: toolSchema }],
		messages: convertAnthropicMessages(encoded.messages, nativeModel, true, { credentialId }), stream: true };
}
function envelope(turn: ThreadTurn, response: AssistantMessage) {
	turn.startAttempt();
	turn.onSseEvent({ event: "message_start", data: JSON.stringify({ type: "message_start", message: { id: response.responseId } }) });
	turn.onSseEvent({ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) });
}
function controlledDescriptorCause(previousContext: Context, previousPayload: WirePayload, response: AssistantMessage,
	nextContext: Context, nextPayload: WirePayload, requestIdentity: Identity) {
	// Explicit counterfactual, NOT a production boundary correction. The host
	// currently forwards enumerable AgentTool internals. This separate owner asks
	// whether the declared Tool surface alone explains the raw context mismatch.
	// Neither raw request nor its owner is modified, and the raw assertion below
	// remains mandatory even if this causal-only probe succeeds.
	const before = { ...previousContext, tools: declaredTools(previousContext.tools), inactiveTools: declaredTools(previousContext.inactiveTools) };
	const after = { ...nextContext, tools: declaredTools(nextContext.tools), inactiveTools: declaredTools(nextContext.inactiveTools) };
	const controlled = new ThreadState();
	const seed = controlled.begin(requestIdentity);
	let next: ThreadTurn | undefined;
	try {
		assert.equal(decision(seed.prepare(previousPayload, before, nativeModel)), "create");
		envelope(seed, response);
		assert.equal(seed.commit(response), true);
		seed.abort();
		next = controlled.begin(requestIdentity);
		const actual = decision(next.prepare(nextPayload, after, nativeModel));
		assert.equal(actual, "continue");
		return { kind: "controlled-descriptor-causal-only", passed: true, actual,
			realHostContinuationVerified: false, rawAssertionStillRequired: true };
	} catch (error) {
		return { kind: "controlled-descriptor-causal-only", passed: false,
			errorClass: error instanceof Error ? error.name : typeof error,
			realHostContinuationVerified: false, rawAssertionStillRequired: true };
	} finally { seed.abort(); next?.abort(); }
}
function integrity(error: unknown): boolean {
	return error !== null && typeof error === "object" && "code" in error && error.code === "RECODE_CLAUDE_REPLAY_INTEGRITY";
}
function ownedBindings() {
	assert(created);
	return created.session.sessionManager.getBranch().filter(entry => entry.type === "custom_message"
		&& entry.customType === "client-bridge-binding" && entry.details !== null && typeof entry.details === "object"
		&& "source" in entry.details && entry.details.source === "tern-omp-client-bridge");
}
function extension(api: ExtensionAPI) {
	// Resume notice is staged before Bridge so native developer adjacency is exercised.
	api.on("before_agent_start", (_event, ctx) => {
		if (ctx.sessionManager.getBranch().some(entry => entry.type === "custom_message" && entry.customType === "binding-smoke-resume")) return;
		return { message: { customType: "binding-smoke-resume", content: "Synthetic resume notice", display: false, attribution: "agent" } };
	});
	installClientBridge(api, broker);
	// This runs after Bridge staged its payload, but before the host commits any of it.
	api.on("before_agent_start", (_event, ctx) => {
		if (preparation === "cancel" || preparation === "throw-and-cancel") ctx.abort();
		if (preparation === "throw" || preparation === "throw-and-cancel") throw new Error("Synthetic contained handler error");
	});
	api.on("session_before_compact", event => {
		compactions++;
		return { compaction: { summary: "Synthetic authoritative host compaction fixture; no model summarization.",
			shortSummary: "Synthetic compaction", firstKeptEntryId: "", tokensBefore: event.preparation.tokensBefore } };
	});
	api.registerTool({ name: toolName, label: "Synthetic echo", description: "Offline fixture, no filesystem/desktop/network effects",
		parameters: api.zod.object({ value: api.zod.string() }), approval: "read", async execute(_id, input) {
			const params = record(input);
			assert.equal(typeof params.value, "string", "Synthetic echo requires a string value");
			executedTools++;
			return { content: [{ type: "text", text: `Synthetic echo: ${params.value}` }], details: { synthetic: true } };
		} });
}
async function prompt(text: string, rounds: number, expected: string) {
	assert(created);
	nextReplies = rounds;
	expectedFirstDecision = expected;
	streamFailure = undefined;
	const before = captures.length;
	await created.session.prompt(text);
	if (streamFailure) throw streamFailure;
	assert.equal(captures.length - before, rounds, "Actual host did not produce the expected synthetic request rounds");
	assert.equal(nextReplies, 0);
}
async function packageInfo(modulePath: string, name: string) {
	let directory = dirname(modulePath);
	for (;;) {
		try {
			const pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
			if (pkg.name === name) return { name, version: pkg.version, path: directory };
		} catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error; }
		const parent = dirname(directory);
		assert.notEqual(parent, directory, `Cannot identify installed package ${name}`);
		directory = parent;
	}
}
try {
	const settings = await Settings.init({ cwd: root, agentDir: join(root, "agent"), inMemory: true, overrides: {
		"tools.approval": { [toolName]: "allow" }, "compaction.enabled": false,
		"compaction.methodOrder": ["soft"], "compaction.keepRecentTokens": 1,
		"eval.py": false, "eval.js": false, "eval.autoProvision": false,
	} });
	const manager = SessionManager.create(root, join(root, "sessions"));
	const auth = new AuthStorage(new SqliteAuthCredentialStore(database));
	const models = new ModelRegistry(auth, join(root, "models.yml"), { ignoreLocalModelConfig: true, cacheDbPath: join(root, "models.db"), settings });
	// Make the explicit synthetic model resolvable during real resume/branch transitions.
	// The registry receives only a fixture key; the transport remains the guarded stream below.
	models.registerProvider(nativeModel.provider, { api: nativeModel.api, baseUrl: nativeModel.baseUrl,
		apiKey: "synthetic-not-used", models: [nativeModel] });
	created = await createAgentSession({ cwd: root, agentDir: join(root, "agent"), settings, sessionManager: manager,
		authStorage: auth, modelRegistry: models, model: nativeModel, getApiKey: () => "synthetic-not-used",
		bindProcessState: false, cacheWarming: false, autoTitle: false, enableMCP: false, enableLsp: false, enableIrc: false,
		skipPythonPreflight: true, disableExtensionDiscovery: true, extensions: [extension],
		skills: [], rules: [], contextFiles: [], promptTemplates: [], slashCommands: [], toolNames: [toolName], requireYieldTool: false,
	});
	assert.deepEqual(created.extensionsResult.errors, []);
	const session = created.session;
	const runner = session.extensionRunner;
	assert(runner, "Actual host ExtensionRunner missing");
	runner.onError(error => {
		if (error.error.includes("Synthetic contained handler error")) containedHandlerErrors++;
		else failures.push(`${error.event}: ${error.error}`);
	});
	// SDK embedders bind the mode's public actions exactly as native modes do. No fake
	// history writer: all prompts, commits, compaction and switching below use AgentSession.
	runner.initialize({ sendMessage: unexpected, sendUserMessage: unexpected, appendEntry: unexpected, setLabel: unexpected,
		getActiveTools: () => session.getEnabledToolNames(), getAllTools: () => session.getAllToolInfos(), setActiveTools: unexpected,
		getCommands: () => [], setModel: unexpected, getThinkingLevel: () => session.thinkingLevel, setThinkingLevel: unexpected,
		getSessionName: () => session.sessionName, setSessionName: unexpected,
	}, { getModel: () => session.model, isIdle: () => !session.isStreaming,
		abort: () => { cancelPending = session.abort(); }, hasPendingMessages: () => false, shutdown: unexpected,
		getContextUsage: () => session.getContextUsage(), compact: unexpected, getSystemPrompt: () => session.systemPrompt,
	}, undefined, undefined, "rpc");
	await runner.emit({ type: "session_start" });
	assert(watchers.has(manager.getSessionId()), "Shipped Bridge did not activate its watch");
	await session.sendCustomMessage({ customType: "client-bridge-binding", content: bindingDescription(stateFor(manager.getSessionId())), display: false }, { triggerTurn: false });
	const legacyPrefix = structuredClone(manager.getBranch());

	session.agent.streamFn = (_model, context) => {
		streamDispatches++;
		const stream = new AssistantMessageEventStream();
		try {
			assert(preparation === "accept" || preparation === "throw", "Explicitly cancelled preparation reached provider boundary");
			assert(nextReplies > 0, "Unexpected automatic provider request");
			const round = ++serial;
			const first = expectedFirstDecision;
			expectedFirstDecision = "continue";
			const capturedContext = snapshotContext(context);
			const payload = wire(capturedContext);
			const audit = requestAudit(capturedContext, payload, _model);
			const threadEvents: Readonly<Record<string, unknown>>[] = [];
			const turn = owner.begin(identity(manager.getSessionId()), event => { threadEvents.push(event); });
			try {
				const outgoing = turn.prepare(payload, capturedContext, nativeModel);
				const type = decision(outgoing);
				let externalContextMismatch = false;
				if (type !== first) {
					const previous = captures.at(-1);
					const expectedIndex = previous?.audit.historyCount;
					const replayed = expectedIndex === undefined ? undefined : capturedContext.messages[expectedIndex];
					const prefixContext = previous ? { ...capturedContext, messages: capturedContext.messages.slice(0, previous.audit.historyCount) } : undefined;
					const prefixAudit = prefixContext ? requestAudit(prefixContext, payload, _model) : undefined;
					const encoded = nativeModel.requiresGlyphTokenization ? applyGlyphCodec(capturedContext).context : capturedContext;
					const encodedResponse = expectedIndex === undefined ? undefined : encoded.messages[expectedIndex];
					const projectedResponse = encodedResponse ? convertAnthropicMessages([encodedResponse], nativeModel, true,
						{ credentialId: replayed?.role === "assistant" ? replayed.credentialId : undefined }) : undefined;
					const suffix = expectedIndex === undefined ? [] : capturedContext.messages.slice(expectedIndex + 1);
					const callIds = replayed?.role === "assistant" ? replayed.content.flatMap(block => block.type === "toolCall" ? [block.id] : []) : [];
					const resultIds = suffix.flatMap(message => message.role === "toolResult" ? [message.toolCallId] : []);
					// Diagnostic mode may finish Bridge-only evidence after this narrowly
					// identified external blocker. It does not claim continuation passed.
					externalContextMismatch = values.diagnostic === true && first === "continue" && type === "create"
						&& threadEvents.some(event => event.phase === "prepare" && event.reason === "context_changed")
						&& previous !== undefined && prefixAudit !== undefined
						&& previous.audit.historyDigest === prefixAudit.historyDigest
						&& previous.responseAudit.digest === fingerprint(replayMessage(replayed)).digest
						&& previous.audit.wire.digest === fingerprint(payload.messages.slice(0, previous.payload.messages.length)).digest
						&& previous.audit.payloadConfig.digest === audit.payloadConfig.digest
						&& previous.audit.model.digest === audit.model.digest
						&& previous.audit.contextConfig.digest !== audit.contextConfig.digest
						&& previous.audit.declaredContextConfig.digest === audit.declaredContextConfig.digest
						&& fingerprint(projectedResponse?.[0]).digest === fingerprint(payload.messages[previous.payload.messages.length]).digest
						&& callIds.length > 0 && suffix.every(message => message.role === "toolResult")
						&& fingerprint(callIds).digest === fingerprint(resultIds).digest;
					if (externalContextMismatch) externalBlockers.push({ round, reason: "undeclared_tool_runtime_context_changed", actual: type });
					console.error(JSON.stringify({ event: "binding-smoke-continuation-mismatch", round, expected: first, actual: type,
						controlledDescriptorCause: values["controlled-descriptors"] && previous && captures.length === 1
							? controlledDescriptorCause(previous.context, previous.payload, previous.response, capturedContext, payload, identity(manager.getSessionId()))
							: { kind: "controlled-descriptor-causal-only", skipped: true, reason: "Requires --controlled-descriptors and the first captured transition" },
						threadEvents, modulePins, previousHistoryCount: expectedIndex ?? null, actualHistoryCount: audit.historyCount,
						previousHistoryDigest: previous?.audit.historyDigest ?? null, actualPrefixDigest: prefixAudit?.historyDigest ?? null,
						expectedResponseIndex: expectedIndex ?? null,
						actualResponseIndex: previous ? capturedContext.messages.findIndex(message => message.role === "assistant" && message.responseId === previous.response.responseId) : null,
						roleAtExpectedResponseIndex: replayed?.role ?? null,
						suffixRoles: expectedIndex === undefined ? [] : capturedContext.messages.slice(expectedIndex).map(message => message.role),
						historyPrefix: previous && prefixAudit ? differences(previous.audit.history, prefixAudit.history) : null,
						replayedResponse: previous ? differences(previous.responseAudit, fingerprint(replayMessage(replayed))) : null,
						wirePrefix: previous ? differences(previous.audit.wire, fingerprint(payload.messages.slice(0, previous.payload.messages.length))) : null,
						contextConfiguration: previous ? differences(previous.audit.contextConfig, audit.contextConfig) : null,
						declaredContextConfiguration: previous ? differences(previous.audit.declaredContextConfig, audit.declaredContextConfig) : null,
						diagnosticExternalBlocker: externalContextMismatch,
						payloadConfiguration: previous ? differences(previous.audit.payloadConfig, audit.payloadConfig) : null,
						requestedModel: previous ? differences(previous.audit.model, audit.model) : null,
						assistantProjection: previous ? differences(fingerprint(projectedResponse?.[0]), fingerprint(payload.messages[previous.payload.messages.length])) : null,
					}, null, 2));
				}
				if (!externalContextMismatch) assert.equal(type, first, `Unexpected thread decision at actual host request ${round}`);
				if (type === "continue") {
					const previous = captures.at(-1)!;
					assert.equal(record(record(outgoing).diagnostics).previous_message_id, previous.response.responseId);
					assert.deepEqual(payload.messages.slice(0, previous.payload.messages.length), previous.payload.messages,
						"Existing final native-wire prefix changed content, order or role");
				}
				const toolUse = --nextReplies > 0;
				const response: AssistantMessage = { role: "assistant", api: nativeModel.api, provider: nativeModel.provider, model: nativeModel.id,
					credentialId, responseId: `synthetic-binding-response-${round}`,
					content: [{ type: "thinking", thinking: "", thinkingSignature: `synthetic-binding-signature-${round}` },
						...(toolUse ? [{ type: "toolCall" as const, id: `synthetic-tool-${round}`, name: toolName, arguments: { value: "\uE001-synthetic" } }]
							: [{ type: "text" as const, text: "Synthetic final response; no production model contacted." }])],
					usage: structuredClone(zeroUsage), stopReason: toolUse ? "toolUse" : "stop", timestamp: Date.now() };
				envelope(turn, response);
				assert.equal(turn.commit(response), true, "Synthetic complete envelope was not committed by unmodified Recode");
				captures.push({ context: capturedContext, payload, response: structuredClone(response), decision: type, audit, responseAudit: fingerprint(replayMessage(response)), externalContextMismatch });
				stream.push({ type: "start", partial: response });
				stream.push({ type: "done", reason: toolUse ? "toolUse" : "stop", message: response });
				stream.end();
			} finally { turn.abort(); }
		} catch (error) { streamFailure = error; stream.fail(error); }
		return stream;
	};

	// Handler throws are contained by ExtensionRunner, not prompt rejections. Only
	// an explicit abort invalidates this staged preparation; assert dispatch itself.
	preparation = "throw-and-cancel";
	await session.prompt("Synthetic contained handler error with explicit preparation abort");
	await cancelPending;
	if (streamFailure) throw streamFailure;
	assert.equal(containedHandlerErrors, 1);
	assert.equal(ownedBindings().length, 0);
	assert.equal(streamDispatches, 0);
	assert.equal(captures.length, 0);
	preparation = "cancel";
	await session.prompt("Synthetic cancelled preparation");
	await cancelPending;
	if (streamFailure) throw streamFailure;
	assert.equal(ownedBindings().length, 0);
	assert.equal(streamDispatches, 0);
	assert.equal(captures.length, 0);
	preparation = "accept";
	cases.push({ name: "real-host-explicitly-aborted-preparations-do-not-commit-or-dispatch",
		detail: "A contained handler error alone does not reject a preparation; the first case explicitly aborts too." });
	await prompt("Synthetic user turn \uE001; use the offline fixture twice.", 3, "create");
	assert.equal(executedTools, 2);
	assert.equal(ownedBindings().length, 1);
	assert.deepEqual(manager.getBranch().slice(0, legacyPrefix.length), legacyPrefix, "Legacy snapshot was rewritten");
	if (!values.diagnostic) assert.deepEqual(captures.slice(0, 3).map(item => item.decision), ["create", "continue", "continue"]);
	else {
		assert.equal(captures[0]!.decision, "create");
		assert(captures.slice(1, 3).every(capture => capture.decision === "continue" || capture.externalContextMismatch));
	}
	assert(captures[1]!.payload.messages.some(message => Array.isArray(message.content) && message.content.some(block => record(block).type === "thinking")), "Native conversion lost synthetic signed thinking");
	cases.push({ name: "real-host-three-rounds-stable-native-wire", decision: captures.slice(0, 3).map(item => item.decision).join(","),
		detail: externalBlockers.length ? "Binding/native-wire checks passed; raw continuation is blocked by undeclared runtime tool context." : "Raw continuation verified." });

	// Negative fixtures are mutations of actual captured host requests, not replacement
	// arrays standing in for the primary integration. Every case seeds a fresh real owner
	// with its synthetic response through the complete public SSE-envelope lifecycle.
	const first = captures[0]!;
	const second = captures[1]!;
	const firstIdentity = identity(manager.getSessionId());
	function seed(response: AssistantMessage = first.response) {
		const isolated = new ThreadState();
		const turn = isolated.begin(firstIdentity);
		try {
			assert.equal(decision(turn.prepare(structuredClone(first.payload), snapshotContext(first.context), nativeModel)), "create");
			envelope(turn, response);
			return { isolated, committed: turn.commit(response) };
		} finally { turn.abort(); }
	}
	function rejectContinuation(name: string, mutate: (context: Context) => void) {
		const { isolated, committed } = seed();
		assert.equal(committed, true);
		const context = snapshotContext(second.context);
		mutate(context);
		const turn = isolated.begin(firstIdentity);
		try {
			let outcome: string;
			try { outcome = decision(turn.prepare(wire(context), context, nativeModel)); }
			catch (error) { if (!integrity(error)) throw error; outcome = "integrity-reject"; }
			assert.notEqual(outcome, "continue", name);
			cases.push({ name, decision: outcome });
		} finally { turn.abort(); }
	}
	const bindingIndex = first.context.messages.findLastIndex(message => message.role === "developer" && JSON.stringify(message.content).includes("Client target:"));
	assert(bindingIndex >= 0);
	rejectContinuation("moving-binding-tail", context => { const [binding] = context.messages.splice(bindingIndex, 1); assert(binding); context.messages.push(binding); });
	rejectContinuation("binding-role-change", context => {
		const message = context.messages[bindingIndex]!;
		assert(message.role === "developer");
		context.messages[bindingIndex] = { ...message, role: "user" };
	});
	rejectContinuation("history-prefix-reorder", context => {
		assert(bindingIndex > 0);
		const previous = context.messages[bindingIndex - 1]!;
		context.messages[bindingIndex - 1] = context.messages[bindingIndex]!;
		context.messages[bindingIndex] = previous;
	});
	rejectContinuation("history-content-edit", context => {
		const message = context.messages[bindingIndex]!;
		assert(message.role === "developer");
		context.messages[bindingIndex] = { ...message, content: "Synthetic edited old binding" };
	});
	rejectContinuation("incomplete-tool-pair", context => { context.messages = context.messages.filter(message => message.role !== "toolResult"); });
	rejectContinuation("new-developer-suffix", context => { context.messages.push({ role: "developer", content: "Synthetic genuinely changed binding", timestamp: Date.now() }); });
	const transformed = { ...structuredClone(first.response), inputTransformations: [{ type: "thinking_dropped" as const, path: "messages.0.content.0", reason: "synthetic_input_transformation" }] };
	const transformedSeed = seed(transformed);
	assert.equal(transformedSeed.committed, false);
	const afterTransformation = transformedSeed.isolated.begin(firstIdentity);
	try {
		let outcome: string;
		try { outcome = decision(afterTransformation.prepare(structuredClone(second.payload), snapshotContext(second.context), nativeModel)); }
		catch (error) { if (!integrity(error)) throw error; outcome = "integrity-reject"; }
		assert.notEqual(outcome, "continue");
		cases.push({ name: "nonempty-input-transformations", decision: outcome });
	} finally { afterTransformation.abort(); }

	const oldState = stateFor(manager.getSessionId());
	const changed: ServerState = { ...oldState, binding: { ...oldState.binding, revision: 1, clientId: "synthetic-device" },
		devices: [{ id: "synthetic-device", name: "Synthetic device", platform: "linux", arch: "synthetic", online: true }] };
	states.set(manager.getSessionId(), changed);
	watchers.get(manager.getSessionId())!(changed);
	const beforeChanged = structuredClone(manager.getBranch());
	assert.equal(ownedBindings().length, 1, "Watch delivery must not append model history");
	preparation = "throw";
	await prompt("Synthetic next prepared user turn after a genuine binding change and a contained handler error", 1, "create");
	preparation = "accept";
	assert.equal(containedHandlerErrors, 2);
	assert.equal(ownedBindings().length, 2);
	assert.deepEqual(manager.getBranch().slice(0, beforeChanged.length), beforeChanged);
	cases.push({ name: "real-binding-change-appends-and-rebuilds", decision: "create" });
	cases.push({ name: "contained-handler-error-does-not-rollback-accepted-host-history",
		detail: "The actual host dispatches and commits the binding once despite a later handler throwing." });

	await manager.flush();
	const resumeFile = manager.getSessionFile();
	assert(resumeFile);
	assert.equal(await session.newSession(), true);
	await prompt("Synthetic other session", 1, "create");
	assert.equal(ownedBindings().length, 1);
	assert.equal(await session.switchSession(resumeFile), true);
	const resumedCount = ownedBindings().length;
	await prompt("Synthetic resumed original session", 1, "create");
	assert.equal(ownedBindings().length, resumedCount, "Resume duplicated an unchanged binding");
	cases.push({ name: "real-session-switch-and-resume-isolation", decision: "create" });

	const branchEntry = manager.getBranch().find(entry => entry.type === "message" && entry.message.role === "user");
	assert(branchEntry);
	assert.equal((await session.branch(branchEntry.id)).cancelled, false);
	await prompt("Synthetic branched session", 1, "create");
	assert.equal(ownedBindings().length, 1);
	cases.push({ name: "real-host-branch-safe-rebuild", decision: "create" });
	const beforeCompactionRequests = captures.length;
	await session.compact("Use the explicit synthetic compaction hook; never contact a model.");
	assert.equal(compactions, 1, "Host did not execute the synthetic compaction hook");
	assert.equal(captures.length, beforeCompactionRequests, "Compaction unexpectedly requested a model");
	assert(!manager.buildSessionContext().messages.some(message => message.role === "custom" && message.customType === "client-bridge-binding"));
	await prompt("Synthetic next prepared user turn after committed compaction", 1, "create");
	assert(manager.buildSessionContext().messages.some(message => message.role === "custom" && message.customType === "client-bridge-binding"));
	cases.push({ name: "real-host-compaction-next-user-turn-restoration", decision: "create" });
	assert.deepEqual(failures, []);
	assert.equal(blockedNetworkCalls, 0, "An unexpected component attempted network I/O; the guard prevented it");
	const report = { passed: externalBlockers.length === 0, bridgeChecksPassed: true, rawContinuationVerified: externalBlockers.length === 0,
		status: externalBlockers.length ? "blocked_by_external_context_digest" : "passed", mode: values.diagnostic ? "diagnostic" : "strict",
		productionRequests: 0, syntheticResponses: captures.length, executedSyntheticTools: executedTools,
		blockedNetworkCalls, blockedPreconnects, shallowMessageSnapshots, cases, modulePins, externalBlockers,
		versions: { host: await packageInfo(fileURLToPath(import.meta.resolve("@oh-my-pi/pi-coding-agent")), "@oh-my-pi/pi-coding-agent"),
			ai: await packageInfo(fileURLToPath(import.meta.resolve("@oh-my-pi/pi-ai")), "@oh-my-pi/pi-ai"),
			recodeAi: await packageInfo(Bun.resolveSync("@oh-my-pi/pi-ai", dirname(resolve(threadPath))), "@oh-my-pi/pi-ai"),
			bridge: JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version,
			recode: await packageInfo(resolve(threadPath), "omp-codex-sg"),
			recodeThread: { path: resolve(threadPath), sha256: createHash("sha256").update(await readFile(resolve(threadPath))).digest("hex") },
			recodeModels: { path: resolve(modelsPath), sha256: createHash("sha256").update(await readFile(resolve(modelsPath))).digest("hex") } },
		limitations: ["Synthetic SSE envelopes and signatures exercise checkpoint logic, not server cryptographic verification.",
			"Uses the SDK resolved by this script; records its actual package path/version, not the installed CLI version.",
			"Compaction restoration is asserted on the next prepared user turn, not an automatic tool-only continuation.",
			"Native wire is produced by the real host Anthropic converter; no production HTTP request is issued."] };
	if (values.report) await writeFile(resolve(values.report), JSON.stringify(report, null, 2) + "\n", { mode: 0o600, flag: "wx" });
	console.log(JSON.stringify(report, null, 2));
	if (externalBlockers.length) process.exitCode = 2;
} finally {
	await created?.session.dispose();
	database.close();
	await rm(root, { recursive: true, force: true });
	const moduleDrift = [];
	for (const module of modulePins) {
		const sha256 = createHash("sha256").update(await readFile(module.path)).digest("hex");
		if (sha256 !== module.sha256) moduleDrift.push({ role: module.role, path: module.path, beforeHash: module.sha256, afterHash: sha256 });
	}
	if (moduleDrift.length) console.error(JSON.stringify({ event: "binding-smoke-module-drift", modules: moduleDrift }));
	assert.deepEqual(moduleDrift, [], "Selected module changed during this smoke; results are not version-stable");
}
