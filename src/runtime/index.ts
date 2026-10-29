// SPDX-License-Identifier: MPL-2.0
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Subprocess } from "bun";
import { getAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { BridgeError, type ExecuteRequest, type ExecutionOptions, type Executor, type ToolResult } from "../protocol.ts";
import { assertSupportedRuntime } from "../config.ts";
import type { InteractionHandler } from "./interactions.ts";
import { WorkerOutputSchema, type WorkerInput, type WorkerOutput } from "./messages.ts";
import type { RuntimeEnvironment } from "./environment.ts";
export type { RuntimeEnvironment } from "./environment.ts";

export interface OmpRuntimeOptions {
	stateDir: string;
	cwd?: string;
	onInteraction?: InteractionHandler;
}

interface PendingCall {
	resolve(result: ToolResult): void;
	reject(error: Error): void;
	cleanup(): void;
}

/** One process owns all SDK module globals, native registries and retained kernels of one context. */
class RuntimeProcess {
	readonly #process: Subprocess<"ignore", "ignore", "pipe">;
	readonly #ready = Promise.withResolvers<RuntimeEnvironment>();
	readonly #closed = Promise.withResolvers<void>();
	readonly #pending = new Map<string, PendingCall>();
	readonly #updates = new Map<string, NonNullable<ExecutionOptions["onUpdate"]>>();
	readonly #backgroundResults = new Map<string, NonNullable<ExecutionOptions["onBackgroundResult"]>>();
	readonly #interactions = new Map<string, AbortController>();
	#failure?: Error;
	#closing?: Promise<void>;
	#stderr = "";
	#retainedState = true;
	#cleanupError?: Error;
	readonly #initialization: Extract<WorkerInput, { type: "init" }>;
	#booted = false;
	#initialized = false;

	private constructor(readonly dir: string, private readonly options: OmpRuntimeOptions, contextId: string, owner: string, nativeRoot: string, private readonly rootAlias?: string) {
		this.#initialization = { type: "init", cwd: resolve(options.cwd ?? homedir()), stateDir: dir, owner, contextId, agentDir: getAgentDir(), configFiles: process.env.PI_CONFIG_FILES?.split(delimiter).filter(Boolean) ?? [], hasInteractions: options.onInteraction !== undefined };
		// SDK config roots and daemon/Python/browser caches must not attach to a different OMP process.
		// Keep the actual user's HOME, PATH and OS shell; these are not an emulated POSIX device.
		const env: Record<string, string | undefined> = { ...process.env };
		for (const name of Object.keys(env)) {
			if (name.startsWith("PI_") || name.startsWith("OMP_") || name === "NODE_CHANNEL_FD" || name === "NODE_CHANNEL_SERIALIZATION_MODE") delete env[name];
		}
		env.PI_CONFIG_DIR = relative(homedir(), nativeRoot);
		env.PI_CODING_AGENT_DIR = join(dir, "native", "agent");
		env.XDG_STATE_HOME = join(dir, "xdg-state");
		env.XDG_DATA_HOME = join(dir, "xdg-data");
		env.XDG_CACHE_HOME = join(dir, "xdg-cache");
		const subprocess = Bun.spawn([process.execPath, fileURLToPath(new URL("./worker.ts", import.meta.url))], {
			cwd: options.cwd ?? homedir(), env, stdin: "ignore", stdout: "ignore", stderr: "pipe",
			ipc: (message, child) => {
				const parsed = WorkerOutputSchema.safeParse(message);
				if (parsed.success) this.#receive(parsed.data);
				else { this.#fail(new BridgeError("invalid_runtime_message", parsed.error.message)); child.kill("SIGKILL"); }
			}, serialization: "advanced",
		});
		this.#process = subprocess;
		void (async () => {
			const decoder = new TextDecoder();
			for await (const chunk of subprocess.stderr) this.#stderr = (this.#stderr + decoder.decode(chunk, { stream: true })).slice(-16_384);
		})().catch(() => undefined);
		void subprocess.exited.then(code => {
			if (!this.#closing) this.#fail(new BridgeError("runtime_exited", `Native runtime exited (${code}); the execution outcome may be unknown. No operation was replayed.\n${this.#stderr}`));
			this.#closed.resolve();
		});
		const timer = setTimeout(() => {
			this.#fail(new BridgeError("runtime_start_timeout", `Native runtime did not initialize within 30 seconds (${this.#booted ? "native initialization" : "worker bootstrap"}).\n${this.#stderr}`));
			subprocess.kill("SIGKILL");
		}, 30_000);
		void this.#ready.promise.then(() => clearTimeout(timer), () => clearTimeout(timer));
	}

	static async start(dir: string, options: OmpRuntimeOptions, contextId: string, owner: string): Promise<RuntimeProcess> {
		const nativeDir = join(dir, "native");
		await mkdir(nativeDir, { recursive: true, mode: 0o700 });
		let rootAlias: string | undefined;
		let nativeRoot = nativeDir;
		try {
			// SDK config roots are HOME-relative. A Windows junction preserves the user's
			// real HOME while allowing the bridge state directory on a different volume.
			if (process.platform === "win32" && isAbsolute(relative(homedir(), nativeDir))) {
				rootAlias = await mkdtemp(join(homedir(), ".tern-omp-native-"));
				nativeRoot = join(rootAlias, "config");
				await symlink(nativeDir, nativeRoot, "junction");
			}
			return new RuntimeProcess(dir, options, contextId, owner, nativeRoot, rootAlias);
		} catch (error) {
			if (rootAlias) await rm(rootAlias, { recursive: true, force: true });
			throw error;
		}
	}

	#send(message: WorkerInput): void {
		this.#process.send(message);
	}

	#fail(error: Error): void {
		this.#failure ??= error;
		this.#ready.reject(error);
		for (const pending of this.#pending.values()) { pending.cleanup(); pending.reject(error); }
		this.#pending.clear();
		for (const controller of this.#interactions.values()) controller.abort(error);
		this.#interactions.clear();
		this.#updates.clear();
		this.#backgroundResults.clear();
	}

	#receive(message: WorkerOutput): void {
		switch (message.type) {
			case "booted":
				if (this.#booted) return;
				this.#booted = true;
				if (!this.#failure && !this.#closing) this.#send(this.#initialization);
				return;
			case "ready": this.#initialized = true; this.#ready.resolve(message.environment); return;
			case "closed":
				this.#retainedState = message.retainedState;
				if (message.errors.length) this.#cleanupError = new BridgeError("runtime_cleanup_failed", message.errors.join("\n"));
				this.#closed.resolve();
				return;
			case "interaction-cancel": this.#interactions.get(message.id)?.abort(new Error("Native interaction cancelled")); return;
			case "interaction": {
				const controller = new AbortController();
				this.#interactions.set(message.request.id, controller);
				void (async () => {
					let choice: string | null = null;
					try {
						if (!this.#closing && !this.#failure && this.options.onInteraction) {
							const cancelled = Promise.withResolvers<{ choice: null }>();
							const abort = () => cancelled.resolve({ choice: null });
							controller.signal.addEventListener("abort", abort, { once: true });
							let decision;
							try { decision = await Promise.race([this.options.onInteraction(message.request, controller.signal), cancelled.promise]); }
							finally { controller.signal.removeEventListener("abort", abort); }
							if (!controller.signal.aborted && message.request.choices.some(item => item.id === decision.choice)) choice = decision.choice;
						}
					} finally {
						this.#interactions.delete(message.request.id);
						if (!this.#failure) this.#send({ type: "interaction", id: message.request.id, decision: { choice } });
					}
				})().catch(() => undefined); // A failed UI path already sends denial, never approval.
				return;
			}
			case "update":
				if (message.done) this.#backgroundResults.get(message.requestId)?.(message.result);
				else this.#updates.get(message.requestId)?.(message.result);
				return;
			case "released":
				this.#updates.delete(message.requestId);
				this.#backgroundResults.delete(message.requestId);
				return;
			case "result": {
				const pending = this.#pending.get(message.requestId);
				if (!pending) return;
				this.#pending.delete(message.requestId);
				pending.cleanup();
				pending.resolve(message.result);
				if (!message.retain) {
					this.#updates.delete(message.requestId);
					this.#backgroundResults.delete(message.requestId);
				}
				return;
			}
			case "error": {
				const error = new BridgeError(message.code ?? "native_tool_error", message.message);
				error.name = message.name;
				if (!message.requestId) {
					if (this.#closing) { this.#cleanupError = error; this.#closed.resolve(); }
					this.#fail(error);
					return;
				}
				const pending = this.#pending.get(message.requestId);
				this.#pending.delete(message.requestId);
				if (!message.retain) {
					this.#updates.delete(message.requestId);
					this.#backgroundResults.delete(message.requestId);
				}
				pending?.cleanup();
				pending?.reject(error);
			}
		}
	}

	async execute(request: ExecuteRequest, options: ExecutionOptions = {}): Promise<ToolResult> {
		options.signal?.throwIfAborted();
		const cancelledBeforeStart = Promise.withResolvers<never>();
		const abortBeforeStart = () => cancelledBeforeStart.reject(options.signal?.reason ?? new Error("Native request cancelled before dispatch"));
		options.signal?.addEventListener("abort", abortBeforeStart, { once: true });
		try { await Promise.race([this.#ready.promise, cancelledBeforeStart.promise]); }
		finally { options.signal?.removeEventListener("abort", abortBeforeStart); }
		options.signal?.throwIfAborted();
		if (this.#failure) throw this.#failure;
		if (this.#closing) throw new BridgeError("context_closed", "Native context is closing");
		const id = request.target.requestId;
		if (this.#pending.has(id) || this.#updates.has(id) || this.#backgroundResults.has(id)) throw new BridgeError("duplicate_request", "Request already dispatched to native context");
		const result = Promise.withResolvers<ToolResult>();
		let abortTimer: NodeJS.Timeout | undefined;
		const abort = () => {
			this.#send({ type: "abort", requestId: id });
			abortTimer = setTimeout(() => {
				this.#fail(new BridgeError("runtime_abort_timeout", "Native runtime did not acknowledge cancellation. Its context was terminated; state is no longer available and outcome may be unknown."));
				this.#process.kill("SIGKILL");
			}, 10_000);
		};
		this.#pending.set(id, { ...result, cleanup: () => { clearTimeout(abortTimer); options.signal?.removeEventListener("abort", abort); } });
		if (options.onUpdate) this.#updates.set(id, options.onUpdate);
		if (options.onBackgroundResult) this.#backgroundResults.set(id, options.onBackgroundResult);
		options.signal?.addEventListener("abort", abort, { once: true });
		try { this.#send({ type: "execute", request }); }
		catch (error) { this.#fail(error instanceof Error ? error : new Error(String(error))); }
		return result.promise;
	}

	inspect(): Promise<RuntimeEnvironment> {
		return this.#ready.promise;
	}

	close(): Promise<void> {
		return this.#closing ??= (async () => {
			for (const controller of this.#interactions.values()) controller.abort(new Error("Native context closed"));
			if (!this.#initialized) {
				// No execute request can be dispatched before ready. Cancel bootstrap
				// without waiting on SDK initialization that owns no execution resources.
				this.#retainedState = false;
				this.#process.kill("SIGKILL");
			} else {
				try { this.#send({ type: "close" }); } catch { this.#closed.resolve(); }
			}
			const deadline = Promise.withResolvers<void>();
			const timer = setTimeout(() => {
				this.#cleanupError = new BridgeError("runtime_cleanup_timeout", "Native cleanup did not finish within 15 seconds; state was retained for diagnosis.");
				deadline.resolve();
			}, 15_000);
			try {
				await Promise.race([this.#closed.promise, deadline.promise]);
			} finally {
				clearTimeout(timer);
				this.#fail(new BridgeError("context_closed", "Native context closed"));
				this.#process.kill("SIGKILL");
				await this.#process.exited;
				if (!this.#retainedState) {
					await rm(this.dir, { recursive: true, force: true });
					if (this.rootAlias) await rm(this.rootAlias, { recursive: true, force: true });
				}
			}
			if (this.#cleanupError) throw this.#cleanupError;
		})();
	}
}

/** Native tools only: no AgentSession, model request, remote filesystem fallback or shared eval realm. */
export class OmpRuntime implements Executor {
	readonly #contexts = new Map<string, { contextId: string; process: Promise<RuntimeProcess> }>();
	readonly #instance = crypto.randomUUID();
	#closed = false;
	#closePromise?: Promise<void>;

	constructor(private readonly options: OmpRuntimeOptions) {
		assertSupportedRuntime();
	}

	async execute(request: ExecuteRequest, options?: ExecutionOptions): Promise<ToolResult> {
		if (this.#closed) throw new BridgeError("runtime_closed", "Client native runtime is closed");
		options?.signal?.throwIfAborted();
		const { sessionId, contextId, device } = request.target;
		if (device.platform !== process.platform) throw new BridgeError("platform_mismatch", `Invocation targets ${device.platform}, but this executor is ${process.platform}`);
		const key = JSON.stringify([sessionId, contextId, device.id]);
		let entry = this.#contexts.get(key);
		if (!entry) {
			const owner = createHash("sha256").update(key).digest("hex");
			const dir = join(resolve(this.options.stateDir), "runtime", this.#instance, owner, crypto.randomUUID());
			const starting = RuntimeProcess.start(dir, this.options, contextId, owner);
			entry = { contextId, process: starting };
			this.#contexts.set(key, entry);
		}
		return (await entry.process).execute(request, options);
	}

	async disposeContext(contextId: string): Promise<void> {
		const closing: Promise<void>[] = [];
		for (const [key, entry] of this.#contexts) {
			if (entry.contextId !== contextId) continue;
			this.#contexts.delete(key);
			closing.push(entry.process.then(runtime => runtime.close()));
		}
		await Promise.all(closing);
	}

	close(): Promise<void> {
		this.#closed = true;
		return this.#closePromise ??= (async () => {
			const closing = [...this.#contexts.values()].map(entry => entry.process.then(runtime => runtime.close()));
			this.#contexts.clear();
			await Promise.all(closing);
		})();
	}
}

/** Read native configuration/executable discovery in a temporary isolated worker; never scan devices. */
export async function inspectRuntimeEnvironment(cwd: string = homedir()): Promise<RuntimeEnvironment> {
	assertSupportedRuntime();
	const dir = await mkdtemp(join(tmpdir(), "tern-runtime-inspect-"));
	const runtime = await RuntimeProcess.start(dir, { stateDir: dir, cwd }, "inspect", crypto.randomUUID());
	try { return await runtime.inspect(); }
	finally { await runtime.close(); }
}
