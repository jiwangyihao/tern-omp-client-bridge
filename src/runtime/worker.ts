// SPDX-License-Identifier: MPL-2.0
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { validateAgentToolArguments, type AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { getDaemonRuntimeDir, VERSION } from "@oh-my-pi/pi-utils";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { createTools, createXdevState, createBrowserPrelude, createComputerPrelude, type Tool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { EvalPreludeDefinition } from "@oh-my-pi/pi-coding-agent/eval";
import type { ExtensionUIContext, ExtensionUIDialogOptions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { LocalProtocolOptions } from "@oh-my-pi/pi-coding-agent/internal-urls/local-protocol";
import { ArtifactManager } from "@oh-my-pi/pi-coding-agent/session/artifacts";
import { SessionManager, type ReadonlySessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { disposeVmContextsByOwner } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { disposeKernelSessionsByOwner } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import { releaseShellSessions } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import { armIdleCloseForOwner, cancelIdleCloseForOwner, releaseTabsForOwner } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { cfgBrowserIdleCloseSec } from "@oh-my-pi/pi-coding-agent/tools/browser/settings";
import { releaseComputerSessionsForOwner, revokeComputerControlForOwner } from "@oh-my-pi/pi-coding-agent/tools/computer/supervisor";
import { closeDaemonClients, daemonClientForProject } from "@oh-my-pi/pi-coding-agent/launch/client";
import { hasLiveOwnedService, listServices, stopService } from "@oh-my-pi/pi-coding-agent/launch/services";
import { denyError, requestApproval, resolveApproval, resolveApprovalFromContext } from "@oh-my-pi/pi-coding-agent/tools/approval";
import { BridgeError, type ExecuteRequest, type ToolResult } from "../protocol.ts";
import type { InteractionDecision } from "../api.ts";
import { isRecord } from "../json.ts";
import { LocalInteractions } from "./interactions.ts";
import { serializedError, WorkerInputSchema, type WorkerInput, type WorkerOutput } from "./messages.ts";

/** The execution-only native host context, including the SDK's optional approval/UI integration. */
interface RuntimeToolContext extends AgentToolContext {
	settings: Settings;
	hasUI: boolean;
	ui?: ExtensionUIContext;
	model: undefined;
	readonly sessionManager: ReadonlySessionManager;
	isIdle(): boolean;
	hasQueuedMessages(): boolean;
	abort(): void;
	localProtocolOptions?: LocalProtocolOptions;
}

interface Invocation {
	requestId: string;
	controller: AbortController;
	lifetime: AbortController;
	tracked: Set<Promise<unknown>>;
	resources: Set<string>;
	deliveredJobs: Set<string>;
	finished: boolean;
	ui?: ExtensionUIContext;
}
interface EvalRuntime {
	kernelOwner: string;
	queue: Promise<void>;
	current?: Invocation;
	tracked: Set<Promise<unknown>>;
	tools: Map<string, Tool>;
	preludes: EvalPreludeDefinition[];
}
const invocation = new AsyncLocalStorage<Invocation>();
const active = new Map<string, { owner: Invocation; execution: Promise<void> }>();
const interactions = new Map<string, { resolve(decision: InteractionDecision): void }>();
const cleanupCallbacks = new Set<() => void>();
const evalExecutions = new Map<Promise<unknown>, AbortController>();
const jobOrigins = new Map<string, Invocation>();
const serviceOrigins = new Map<string, Invocation>();
const evalRuntimes: Partial<Record<"js" | "py", EvalRuntime>> = {};
let session: ToolSession | undefined;
let storageSession: SessionManager | undefined;
let initializing: Promise<void> | undefined;
let closing: Promise<void> | undefined;
let tools = new Map<string, Tool>();
let owner = "";
let contextId = "";
let hasInteractions = false;

function send(message: WorkerOutput): void {
	if (!process.send) throw new Error("Native worker requires its parent's IPC channel");
	if (process.connected === false && closing) return;
	process.send(message);
}

/** Release callbacks only after the language execution AND its native deferred resources settle. */
function releaseInvocation(current: Invocation): void {
	if (!current.finished || current.resources.size !== 0 || !active.has(current.requestId)) return;
	active.delete(current.requestId);
	send({ type: "released", requestId: current.requestId });
}

function finishBackgroundJob(current: Invocation, jobId: string, result: ToolResult): void {
	if (current.deliveredJobs.has(jobId)) return;
	current.deliveredJobs.add(jobId);
	jobOrigins.delete(jobId);
	current.resources.delete(`job:${jobId}`);
	send({ type: "update", requestId: current.requestId, result, done: true });
	releaseInvocation(current);
}

function trackExecution<T>(execution: Promise<T>, controller: AbortController, current: Invocation | undefined, runtime?: EvalRuntime): Promise<T> {
	if (!current || current.finished) throw new Error("Native Eval execution has no live invocation owner");
	current.tracked.add(execution);
	runtime?.tracked.add(execution);
	evalExecutions.set(execution, controller);
	void execution.then(() => evalExecutions.delete(execution), () => evalExecutions.delete(execution));
	return execution;
}

/** Every UI closure captures an immutable owner, never whichever foreground cell happens to run now. */
function createUi(current: Invocation): ExtensionUIContext | undefined {
	if (!hasInteractions) return undefined;
	const local = new LocalInteractions(contextId, async (request, signal) => {
		if (current.finished) throw new Error("The originating invocation has settled");
		const result = Promise.withResolvers<InteractionDecision>();
		interactions.set(request.id, result);
		const abort = () => { send({ type: "interaction-cancel", id: request.id }); result.resolve({ choice: null }); };
		signal?.addEventListener("abort", abort, { once: true });
		try {
			send({ type: "interaction", requestId: current.requestId, request });
			if (signal?.aborted) abort();
			return await result.promise;
		} finally {
			signal?.removeEventListener("abort", abort);
			interactions.delete(request.id);
		}
	});
	const dialogSignal = (options?: ExtensionUIDialogOptions): AbortSignal => {
		const signals = [current.controller.signal, current.lifetime.signal];
		if (options?.signal) signals.push(options.signal);
		if (options?.timeout !== undefined) signals.push(AbortSignal.timeout(Math.max(1, options.timeout)));
		return AbortSignal.any(signals);
	};
	const supported: Pick<ExtensionUIContext, "confirm" | "select" | "approve" | "notify"> = {
		confirm: (title, message, options) => local.confirm(title, message, { signal: dialogSignal(options) }),
		select: async (title, options, dialogOptions) => {
			const labels = options.map(option => typeof option === "string" ? option : option.label);
			const choice = await local.choose(title, "Choose explicitly on this device.", labels.map((label, index) => ({ id: String(index), label })), dialogSignal(dialogOptions));
			return choice === null ? undefined : labels[Number(choice)];
		},
		approve: (prompt, options) => local.confirm("Approve client operation?", prompt.full, { signal: dialogSignal(options) }),
		notify: (message, level) => send({ type: "update", requestId: current.requestId, result: { content: [{ type: "text", text: message }], details: { notification: level ?? "info" } } }),
	};
	return new Proxy(supported as ExtensionUIContext, {
		get(target, key, receiver) {
			if (Reflect.has(target, key)) return Reflect.get(target, key, receiver);
			if (key === "supportsEditor" || key === "timeoutStartsOnPresentation") return false;
			throw new BridgeError("native_ui_unavailable", `Client runtime does not provide the native UI operation ${String(key)}`);
		},
	});
}

function nativeContext(current: Invocation | undefined = invocation.getStore()): RuntimeToolContext {
	if (!session || !storageSession || !current || current.finished) throw new Error("Native operation has no live invocation owner");
	current.ui ??= createUi(current);
	return {
		settings: session.settings, hasUI: current.ui !== undefined, ui: current.ui, model: undefined,
		sessionManager: storageSession,
		isIdle: () => active.size === 0, hasQueuedMessages: () => false,
		abort: () => current.controller.abort(new Error("Native operation interrupted")),
		localProtocolOptions: session.localProtocolOptions,
	};
}

async function initialize(input: Extract<WorkerInput, { type: "init" }>): Promise<void> {
	owner = input.owner;
	contextId = input.contextId;
	hasInteractions = input.hasInteractions;
	await mkdir(join(input.stateDir, "artifacts"), { recursive: true, mode: 0o700 });
	const files = input.capabilities.includes("files");
	const exec = input.capabilities.includes("exec");
	const settings = await Settings.init({
		cwd: input.cwd, agentDir: join(input.stateDir, "native", "agent"), inMemory: true,
		overrides: {
			"eval.py": exec, "eval.js": exec, "eval.autoProvision": false,
			"python.kernelMode": "session", "task.maxRecursionDepth": 0,
			"computer.enabled": input.capabilities.includes("computer"), "browser.enabled": input.capabilities.includes("browser"),
			"browser.cmux": false, "browser.tern": false, "async.enabled": true, "launch.enabled": exec,
			// Native auto-background Bash creates a fresh shell; explicit async remains available.
			"bash.autoBackground.enabled": false, "tools.approvalMode": "always-ask",
			"tools.approval": {
				read: files ? "allow" : "deny", write: files ? "allow" : "deny", edit: files ? "allow" : "deny",
				grep: files ? "allow" : "deny", glob: files ? "allow" : "deny", bash: exec ? "allow" : "deny", eval: exec ? "allow" : "deny",
				computer: "prompt", browser: "prompt",
			},
		},
	});
	const artifacts = new ArtifactManager(join(input.stateDir, "artifacts"));
	// SessionManager is the SDK's data journal, not AgentSession or a model loop.
	// Adopt the same real artifact store used by native tools so centralized spills
	// remain readable through this context's artifact:// namespace.
	storageSession = SessionManager.inMemory(input.cwd);
	storageSession.adoptArtifactManager(artifacts);
	owner = storageSession.getSessionId();
	const manager = new AsyncJobManager({});
	manager.registerDeliverySink(owner, (jobId, text, job) => {
		const current = jobOrigins.get(jobId);
		if (!current) return;
		const content: ToolResult["content"] = [{ type: "text", text }];
		const details: unknown = job?.latestDetails;
		if (isRecord(details) && Array.isArray(details.images)) {
			for (const image of details.images) if (isRecord(image) && image.type === "image" && typeof image.data === "string" && typeof image.mimeType === "string") content.push({ type: "image", data: image.data, mimeType: image.mimeType });
		}
		finishBackgroundJob(current, jobId, { content, details, ...(job?.status === "failed" ? { isError: true } : {}) });
	});
	const nativeSession: ToolSession = {
		cwd: input.cwd, hasUI: hasInteractions, canPromptUser: hasInteractions, settings,
		sessionManager: storageSession,
		enableLsp: false, enableMCP: false, enableIrc: false, hasEditTool: files, restrictToolNames: true,
		taskDepth: 0, skipPythonPreflight: true,
		getSessionId: () => owner, getEvalSessionId: () => owner, getEvalKernelOwnerId: () => owner, getAgentId: () => owner,
		getSessionFile: () => null, getSessionSpawns: () => "",
		getArtifactsDir: () => artifacts.dir, getArtifactManager: () => artifacts,
		allocateOutputArtifact: tool => artifacts.allocatePath(tool), asyncJobManager: manager,
		getEvalPreludes: () => evalRuntimes.js?.preludes ?? [], getAdvertisedEvalPreludes: () => evalRuntimes.js?.preludes ?? [],
		getToolByName: name => tools.get(name), getToolForEvalBridge: name => tools.get(name),
		getEvalBridgeToolNames: () => [...tools.keys()], getToolContext: () => nativeContext(),
		localProtocolOptions: { getArtifactsDir: () => artifacts.dir, getSessionId: () => owner },
		isDisposed: () => closing !== undefined,
		assertEvalExecutionAllowed: () => { if (closing) throw new Error("Native context is closing"); },
		trackEvalExecution: <T>(execution: Promise<T>, controller: AbortController): Promise<T> => trackExecution(execution, controller, invocation.getStore()),
		registerDisposeCallback: callback => { cleanupCallbacks.add(callback); return () => { cleanupCallbacks.delete(callback); }; },
		queueLaunchCompletion: async notification => {
			const current = serviceOrigins.get(notification.daemon.name);
			if (!current) return;
			send({ type: "update", requestId: current.requestId, result: { content: [{ type: "text", text: JSON.stringify(notification) }], details: notification }, done: true });
			serviceOrigins.delete(notification.daemon.name);
			current.resources.delete(`service:${notification.daemon.name}`);
			releaseInvocation(current);
		},
	};
	session = nativeSession;
	const names = [...(files ? ["read", "write", "edit", "grep", "glob"] : []), ...(exec ? ["bash", "eval"] : [])];
	tools = new Map((await createTools(nativeSession, names)).map(tool => [tool.name, guardedTool(tool)]));
	nativeSession.toolRegistry = tools;
	nativeSession.xdev = createXdevState(nativeSession, tools, new Set(tools.keys()));
	if (exec) {
		for (const language of ["js", "py"] as const) {
			const runtime: EvalRuntime = { kernelOwner: `${owner}:${language}`, queue: Promise.resolve(), tracked: new Set(), tools: new Map(), preludes: [] };
			evalRuntimes[language] = runtime;
			// Native JS/Python bridges retain the ToolSession on each pending run. A
			// language queue owns this facade through full settlement, not foreground return.
			// Mutable file stores still delegate to the one context's base ToolSession.
			const overrides: Partial<ToolSession> = {
				toolRegistry: runtime.tools, xdev: undefined, isToolActive: () => false,
				getEvalKernelOwnerId: () => runtime.kernelOwner,
				getToolByName: name => runtime.tools.get(name), getToolForEvalBridge: name => runtime.tools.get(name),
				getEvalBridgeToolNames: () => [...runtime.tools.keys()], getToolContext: () => nativeContext(runtime.current),
				getEvalPreludes: () => runtime.preludes, getAdvertisedEvalPreludes: () => runtime.preludes,
				trackEvalExecution: <T>(execution: Promise<T>, controller: AbortController): Promise<T> => trackExecution(execution, controller, runtime.current, runtime),
			};
			const scoped = new Proxy(nativeSession, {
				get: (target, key) => Object.hasOwn(overrides, key) ? Reflect.get(overrides, key) : Reflect.get(target, key),
				set: (target, key, value) => Reflect.set(Object.hasOwn(overrides, key) ? overrides : target, key, value),
			});
			if (input.capabilities.includes("computer")) runtime.preludes.push(createComputerPrelude(scoped));
			if (input.capabilities.includes("browser")) runtime.preludes.push(createBrowserPrelude(scoped));
			runtime.tools = new Map((await createTools(scoped, names)).map(tool => [tool.name, guardedTool(tool, () => runtime.current)]));
			scoped.toolRegistry = runtime.tools;
			scoped.xdev = createXdevState(scoped, runtime.tools, new Set(runtime.tools.keys()));
		}
	}
	const shell = settings.getShellConfig();
	const adb = Bun.which("adb");
	send({ type: "ready", environment: {
		platform: process.platform, arch: process.arch, cwd: input.cwd, sdkVersion: VERSION,
		ordinaryShell: { backend: "native-brush", syntax: "POSIX", persistence: "per-context", automaticBackgrounding: false },
		serviceShell: { executable: shell.shell, args: shell.args, ...(shell.prefix ? { prefix: shell.prefix } : {}) },
		adb: { executable: adb, available: adb !== null, deviceAccess: "not-probed", requirement: "Use the local adb executable with an explicit -s serial; USB/wireless debugging authorization remains OS/device-owned." },
		browser: { defaultBackend: "headless-chromium", availability: "not-probed", ownership: "context", requirement: "Native Chromium or an explicitly selected app/CDP/relay backend; no profile or cookie migration. Backend startup errors are returned unchanged." },
		computer: { availability: "not-probed", requirement: "Interactive desktop session, native addon and OS screen/accessibility permissions; local human confirmation is mandatory." },
		limits: [
			"Ordinary Bash uses native embedded brush POSIX syntax, including on Windows; it does not run WSL or pretend to be cmd/PowerShell.",
			"Automatic Bash backgrounding is disabled because SDK 18.10.4 creates a new shell for each auto-background candidate; explicit async jobs remain native and isolated.",
			"Unnamed pty:true requires the unavailable OMP TUI overlay. Named PTY services provide real native terminals and proc:// stdin/output/kill.",
			"Python requires an installed interpreter supported by the native SDK. Browser/computer availability is not claimed until their native backend succeeds.",
			"Model completion, judgment, image questions and reasoning-agent spawning are unavailable in this execution-only runtime.",
		],
	} });
}

function invokeEval(current: Invocation, id: string, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: (result: ToolResult) => void): Promise<ToolResult> {
	const runtime = evalRuntimes[params.language === "py" ? "py" : "js"];
	if (!runtime) throw new Error("Native Eval is unavailable");
	const foreground = Promise.withResolvers<ToolResult>();
	const abortWaiting = () => foreground.reject(signal?.reason ?? new Error("Native Eval cancelled before execution"));
	if (signal?.aborted) { abortWaiting(); return foreground.promise; }
	signal?.addEventListener("abort", abortWaiting, { once: true });
	const execution = runtime.queue.then(async () => {
		signal?.removeEventListener("abort", abortWaiting);
		// A queued cancellation must not acquire or clean up the active cell's owner.
		if (signal?.aborted) return;
		runtime.current = current;
		try {
			const tool = runtime.tools.get("eval");
			if (!tool) throw new Error("Native Eval tool is unavailable");
			foreground.resolve(await tool.execute(id, params, signal, onUpdate, nativeContext(current)));
		} catch (error) {
			foreground.reject(error);
		} finally {
			try {
				while (runtime.tracked.size) {
					const pending = [...runtime.tracked];
					runtime.tracked.clear();
					await Promise.allSettled(pending);
				}
				await revokeComputerControlForOwner(runtime.kernelOwner);
			} finally { runtime.current = undefined; }
		}
	});
	runtime.queue = execution.catch(error => {
		foreground.reject(error);
		send({ type: "error", requestId: current.requestId, ...serializedError(error), retain: current.resources.size > 0 });
	});
	return foreground.promise;
}

function guardedTool(tool: Tool, resolveOwner?: () => Invocation | undefined): Tool {
	const boundMethods = new Map<PropertyKey, unknown>();
	return new Proxy(tool, {
		get(target, property) {
			if (property !== "execute") {
				const value = Reflect.get(target, property, target);
				if (typeof value !== "function" || property === "parameters") return value;
				if (!boundMethods.has(property)) boundMethods.set(property, value.bind(target));
				return boundMethods.get(property);
			}
			return async (id: string, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: (result: ToolResult) => void): Promise<ToolResult> => {
				if (!session || closing) throw new Error("Native context is closing");
				const current = resolveOwner ? resolveOwner() : invocation.getStore();
				const context = nativeContext(current);
				if (!current) throw new Error("Native tool call has no invocation owner");
				signal?.throwIfAborted();
				if (tool.name === "bash" && params.pty === true && !params.name) throw new BridgeError("interactive_pty_unavailable", "Unnamed PTY commands require OMP's terminal overlay, not a permission dialog. Supply a unique name to use a real native managed PTY and proc:// stdin/output/kill.");
				const policy = resolveApprovalFromContext(context);
				const approval = resolveApproval(target, params, policy.approvalMode, policy.userPolicies);
				if (approval.policy === "deny") throw denyError(approval, target.name);
				if (approval.policy === "prompt" && (!context.ui || !await requestApproval(context.ui, target, params, approval.reason))) throw new BridgeError("permission_denied", `Local permission denied for ${target.name}`);
				signal?.throwIfAborted();
				const rememberOwner = (result: ToolResult) => {
					const details = result.details;
					if (!isRecord(details)) return;
					if ((tool.name === "bash" || tool.name === "eval") && isRecord(details.async) && typeof details.async.jobId === "string") {
						const jobId = details.async.jobId;
						if (!jobOrigins.has(jobId) && !current.deliveredJobs.has(jobId)) {
							jobOrigins.set(jobId, current);
							current.resources.add(`job:${jobId}`);
							const job = session?.asyncJobManager?.getJob(jobId);
							// SDK cancel() suppresses its ordinary delivery sink. Settle the original
							// subscription using the job's actual terminal output and status.
							if (job) void job.promise.then(() => {
								if (job.status === "cancelled") finishBackgroundJob(current, jobId, {
									content: [{ type: "text", text: job.errorText ?? job.resultText ?? job.progressText ?? "Native background job cancelled" }],
									details: job.latestDetails, isError: true,
								});
							});
						}
					}
					if (isRecord(details.service) && typeof details.service.name === "string") {
						serviceOrigins.set(details.service.name, current);
						current.resources.add(`service:${details.service.name}`);
					}
				};
				const update = (result: ToolResult) => { rememberOwner(result); onUpdate?.(result); };
				const result = tool.name === "eval" && !resolveOwner
					? await invokeEval(current, id, params, signal, update)
					: await invocation.run(current, () => target.execute(id, params, signal, update, context));
				rememberOwner(result);
				return result;
			};
		},
	});
}

async function execute(request: ExecuteRequest, current: Invocation): Promise<void> {
	const requestId = current.requestId;
	try {
		await initializing;
		if (!session || closing) throw new Error("Native runtime unavailable");
		if (request.target.contextId !== contextId) throw new BridgeError("context_mismatch", "Invocation belongs to another device context");
		current.controller.signal.throwIfAborted();
		const tool = tools.get(request.tool);
		if (!tool) throw new BridgeError("capability_denied", `Native tool ${request.tool} is not enabled on this device`);
		const params = { ...request.params };
		delete params.target;
		delete params.i;
		const validated = validateAgentToolArguments(tool, { type: "toolCall", id: requestId, name: request.tool, arguments: params }, "payload");
		const result = await tool.execute(requestId, validated, current.controller.signal, result => send({ type: "update", requestId, result }), nativeContext(current));
		send({ type: "result", requestId, result, retain: current.resources.size > 0 });
	} catch (error) {
		send({ type: "error", requestId, ...serializedError(error), retain: current.resources.size > 0 });
	} finally {
		while (current.tracked.size) {
			const pending = [...current.tracked];
			current.tracked.clear();
			await Promise.allSettled(pending);
		}
		current.finished = true;
		current.lifetime.abort(new Error("Originating native invocation settled"));
		if (!closing && session) {
			const idleSeconds = cfgBrowserIdleCloseSec.get(session.settings);
			if (idleSeconds > 0) armIdleCloseForOwner(owner, idleSeconds * 1000);
			else cancelIdleCloseForOwner(owner);
		}
		releaseInvocation(current);
	}
}

function close(): Promise<void> {
	return closing ??= (async () => {
		await initializing?.catch(() => undefined);
		for (const entry of active.values()) { entry.owner.controller.abort(new Error("Native context closed")); entry.owner.lifetime.abort(new Error("Native context closed")); }
		for (const controller of evalExecutions.values()) controller.abort(new Error("Native context closed"));
		for (const pending of interactions.values()) pending.resolve({ choice: null });
		cancelIdleCloseForOwner(owner);
		const cleanup: Array<Promise<unknown> | undefined> = [session?.asyncJobManager?.dispose({ timeoutMs: 3_000 }), releaseTabsForOwner(owner, { kill: true }), Promise.allSettled([...active.values()].map(entry => entry.execution))];
		for (const runtime of Object.values(evalRuntimes)) cleanup.push(disposeVmContextsByOwner(runtime.kernelOwner), disposeKernelSessionsByOwner(runtime.kernelOwner), releaseComputerSessionsForOwner(runtime.kernelOwner), runtime.queue);
		let retainedState = false;
		if (session && hasLiveOwnedService(session)) {
			for (const service of await listServices(session)) {
				if (service.owner !== owner) continue;
				if (service.persist || service.detached) { retainedState = true; continue; }
				cleanup.push(stopService(session, service.name).then(() => undefined));
			}
		}
		const errors: string[] = [];
		for (const result of await Promise.allSettled(cleanup)) {
			if (result.status === "rejected") errors.push(serializedError(result.reason).message);
			else if (result.value === false) errors.push("Native background-job cancellation did not settle before its cleanup deadline.");
		}
		if (errors.length) retainedState = true;
		releaseShellSessions(owner);
		for (const callback of cleanupCallbacks) callback();
		if (session && !retainedState) {
			const hasBroker = await stat(getDaemonRuntimeDir(session.cwd)).then(() => true, error => { if (isRecord(error) && error.code === "ENOENT") return false; throw error; });
			if (hasBroker) await (await daemonClientForProject(session.cwd)).request({ op: "shutdown" }, AbortSignal.timeout(5_000));
		}
		await closeDaemonClients();
		await storageSession?.close();
		storageSession?.releaseRetainedEntries();
		send({ type: "closed", retainedState, errors });
		process.disconnect?.();
	})();
}

process.on("message", (raw: unknown) => {
	const parsed = WorkerInputSchema.safeParse(raw);
	if (!parsed.success) { send({ type: "error", name: "BridgeError", code: "invalid_runtime_message", message: parsed.error.message }); return; }
	const message = parsed.data;
	switch (message.type) {
		case "init":
			if (initializing) { send({ type: "error", name: "Error", message: "Native context already initialized" }); return; }
			initializing = initialize(message);
			void initializing.catch(error => send({ type: "error", ...serializedError(error) }));
			return;
		case "execute": {
			const requestId = message.request.target.requestId;
			if (active.has(requestId)) { send({ type: "error", requestId, name: "Error", message: "Duplicate native request" }); return; }
			const current: Invocation = { requestId, controller: new AbortController(), lifetime: new AbortController(), tracked: new Set(), resources: new Set(), deliveredJobs: new Set(), finished: false };
			const execution = invocation.run(current, () => execute(message.request, current));
			active.set(requestId, { owner: current, execution });
			void execution.catch(error => send({ type: "error", requestId, ...serializedError(error) }));
			return;
		}
		case "abort": active.get(message.requestId)?.owner.controller.abort(new Error("Native operation cancelled")); return;
		case "interaction": interactions.get(message.id)?.resolve(message.decision); return;
		case "close": void close().catch(error => { send({ type: "error", ...serializedError(error) }); process.exitCode = 1; process.disconnect?.(); });
	}
});
process.on("disconnect", () => { void close().catch(error => console.error(serializedError(error).message)); });
process.on("SIGTERM", () => { void close().catch(error => console.error(serializedError(error).message)); });
send({ type: "booted" });
