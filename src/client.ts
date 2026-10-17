// SPDX-License-Identifier: MPL-2.0
import { createHash, randomBytes } from "node:crypto";
import { open, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { InteractionDecision, InteractionRequest, LocalUiState, ResolvedView, TransferStatus } from "./api.ts";
import { assertSupportedRuntime, authorized, defaultStateDir, readEndpoint, signIdentity, writePrivateJson, type ClientIdentity, type Endpoint } from "./config.ts";
import { openClientTransport, type ClientConnection, type ClientTransport } from "./client-transport.ts";
import { BridgeError, type ExecuteRequest, type ToolResult } from "./protocol.ts";
import { ClientIdentitySchema, DeviceDescriptorSchema, ExecuteRequestSchema, IdentifierSchema, ImportedFileSchema, ResolvedViewSchema, ServerStateSchema, UiIntentReceiptSchema as ReceiptSchema, UiIntentSchema } from "./schemas.ts";
import { OmpRuntime } from "./runtime/index.ts";
import { HumanTransferSource } from "./transfers/source.ts";
import { isImageAttachment } from "./transfers/policy.ts";
import { RpcPeer, type RpcContext } from "./wire.ts";

const ChallengeSchema = z.object({ nonce: z.string().min(16).max(1024) });
const RegistrationSchema = z.object({ device: DeviceDescriptorSchema, serverName: z.string().min(1).max(256), serverInstance: IdentifierSchema });
const StateEventSchema = z.object({ sessionId: IdentifierSchema, state: ServerStateSchema });
const FinishedEventSchema = z.object({ id: IdentifierSchema, viewId: IdentifierSchema, kind: z.enum(["resolve", "bind", "attach"]), error: z.string().optional() });
const ContextCloseSchema = z.object({ contextId: IdentifierSchema });
const CaptureSchema = z.object({ kind: z.literal("files"), paths: z.array(z.string().min(1).max(32768)).min(1).max(256) }).strict();
const TransferSchema = z.object({ viewId: IdentifierSchema, captureId: IdentifierSchema, expectedSessionId: IdentifierSchema, expectedDraftToken: IdentifierSchema, expectedResolveIntentId: IdentifierSchema }).strict();
const IdSchema = z.object({ id: IdentifierSchema }).strict();
const ReplySchema = z.object({ id: IdentifierSchema, choice: IdentifierSchema.nullable() }).strict();
const UploadBeginSchema = z.object({ id: IdentifierSchema });
const UploadProgressSchema = z.object({ bytesSent: z.number().int().nonnegative() });
const UploadFinishSchema = z.object({ files: z.array(ImportedFileSchema).max(256) });
const OkSchema = z.object({ ok: z.literal(true) });
const IncomingCallSchema = z.object({ kind: z.literal("request"), id: IdentifierSchema, method: z.string(), body: z.unknown() });
const REQUEST_TIMEOUT = 15000;
const CHUNK_BYTES = 256 * 1024;
const MAX_HTTP_BYTES = 1024 * 1024;

export interface ClientServiceOptions {
	identity: ClientIdentity;
	serverName: string;
	stateDir?: string;
	cwd?: string;
	port?: number;
	connection: ClientConnection;
}
export interface ClientService {
	readonly endpoint: Endpoint;
	/** Wait for signed registration and any broker-restart cleanup, not merely HTTP readiness. */
	waitForConnection(signal?: AbortSignal): Promise<void>;
	close(): Promise<void>;
}
interface ConnectionWaiter {
	resolve(): void;
	reject(reason: unknown): void;
}
interface Interaction {
	request: InteractionRequest;
	finish(choice: string | null): void;
}
interface TransferStart {
	resolve(status: TransferStatus): void;
	reject(reason: unknown): void;
}
interface ResultDelivery {
	sent: boolean;
	flush?: () => void;
}
interface TransferJob {
	captureId: string;
	view: ResolvedView;
	peer: RpcPeer;
	controller: AbortController;
	status?: TransferStatus;
	intentId?: string;
	cancelling?: Promise<void>;
	done: Promise<void>;
}

async function jsonBody(request: Request): Promise<unknown> {
	if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new BridgeError("INVALID_CONTENT_TYPE", "Local UI requests require application/json");
	if (!request.body) throw new BridgeError("INVALID_INPUT", "A JSON request body is required");
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			bytes += next.value.byteLength;
			if (bytes > MAX_HTTP_BYTES) { await reader.cancel(); throw new BridgeError("BODY_TOO_LARGE", "Local UI request exceeds its size limit"); }
			chunks.push(next.value);
		}
		try { return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")); }
		catch { throw new BridgeError("INVALID_INPUT", "Local UI request is not valid JSON"); }
	} finally { reader.releaseLock(); }
}

/** Real native executor and local-human input service, with no inbound remote listener. */
export async function startClientService(options: ClientServiceOptions): Promise<ClientService> {
	assertSupportedRuntime();
	const parsedIdentity = ClientIdentitySchema.parse(options.identity);
	const identity: ClientIdentity = { ...parsedIdentity, device: Object.freeze({ ...parsedIdentity.device, capabilities: Object.freeze([...parsedIdentity.device.capabilities]) }) };
	const stateDir = options.stateDir ?? defaultStateDir();
	const source = new HumanTransferSource({ stateDir });
	const views = new Map<string, ResolvedView>();
	const resolveIntents = new Map<string, string>();
	const transfers = new Map<string, TransferJob>();
	const capturesInUse = new Map<string, TransferJob>();
	const attachIntents = new Map<string, TransferJob>();
	const interactions = new Map<string, Interaction>();
	const seenCalls = new Set<string>();
	const tasks = new Set<Promise<unknown>>();
	const responseDeliveries = new WeakMap<object, ResultDelivery>();
	const ownedContexts = new Set<string>();
	const connectionWaiters = new Set<ConnectionWaiter>();
	let serverInstance: string | undefined;
	let brokerGeneration = 0;
	let resettingContexts: Promise<void> | undefined;
	let closed = false;
	let connected = false;
	let serverName = options.serverName;
	let lastUiSeen = 0;
	let peer: RpcPeer | undefined;
	let transport: ClientTransport | undefined;
	let reconnect: NodeJS.Timeout | undefined;
	let handshake: NodeJS.Timeout | undefined;

	function waitForConnection(signal?: AbortSignal): Promise<void> {
		if (closed) return Promise.reject(new BridgeError("CLIENT_CLOSED", "The client service is closed"));
		if (signal?.aborted) return Promise.reject(signal.reason ?? new BridgeError("CANCELLED", "Connection wait was cancelled"));
		if (connected) return Promise.resolve();
		const waiting = Promise.withResolvers<void>();
		const abort = () => waiter.reject(signal?.reason ?? new BridgeError("CANCELLED", "Connection wait was cancelled"));
		const waiter: ConnectionWaiter = {
			resolve() {
				if (!connectionWaiters.delete(waiter)) return;
				signal?.removeEventListener("abort", abort);
				waiting.resolve();
			},
			reject(reason) {
				if (!connectionWaiters.delete(waiter)) return;
				signal?.removeEventListener("abort", abort);
				waiting.reject(reason);
			},
		};
		connectionWaiters.add(waiter);
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		return waiting.promise;
	}

	function track<T>(promise: Promise<T>): Promise<T> {
		tasks.add(promise);
		void promise.finally(() => tasks.delete(promise)).catch(() => {});
		return promise;
	}
	function requestPeer(): RpcPeer {
		if (closed || !connected || !peer) throw new BridgeError("CLIENT_OFFLINE", "The client is offline; this operation was not queued or replayed");
		return peer;
	}
	function denyInteractions(): void {
		for (const interaction of [...interactions.values()]) interaction.finish(null);
	}
	const runtime = new OmpRuntime({ stateDir, cwd: options.cwd, capabilities: identity.device.capabilities, onInteraction: (request, signal) => {
		if (closed || !connected || signal?.aborted || Date.now() - lastUiSeen > 10000 || interactions.size >= 128 || interactions.has(request.id)) return Promise.resolve({ choice: null });
		const decision = Promise.withResolvers<InteractionDecision>();
		const abort = () => finish(null);
		const timer = setTimeout(() => finish(null), 60000);
		function finish(choice: string | null): void {
			if (!interactions.delete(request.id)) return;
			clearTimeout(timer); signal?.removeEventListener("abort", abort);
			decision.resolve({ choice });
		}
		interactions.set(request.id, { request, finish });
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) finish(null);
		return decision.promise;
	} });

	function update(job: TransferJob, change: Partial<TransferStatus>): void {
		if (job.status) job.status = { ...job.status, ...change };
	}
	function guardDestination(job: TransferJob): void {
		job.controller.signal.throwIfAborted();
		if (!connected || peer !== job.peer) throw new BridgeError("CLIENT_OFFLINE", "The original transfer connection is unavailable; upload was not replayed");
		const current = views.get(job.view.viewId);
		if (!current || current.sessionId !== job.view.sessionId || current.draftToken !== job.view.draftToken) throw new BridgeError("DESTINATION_CHANGED", "The captured destination conversation or draft changed");
	}
	async function cancelRemote(job: TransferJob): Promise<void> {
		if (job.cancelling) return await job.cancelling;
		if (!job.status) return;
		if (!connected || peer !== job.peer) throw new BridgeError("OUTCOME_UNKNOWN", "The original upload channel is unavailable; remote cancellation cannot be confirmed");
		job.cancelling = job.peer.request("upload.cancel", { id: job.status.id }, { timeoutMs: REQUEST_TIMEOUT }).then(value => { OkSchema.parse(value); });
		await job.cancelling;
	}
	async function upload(job: TransferJob, ready: TransferStart): Promise<void> {
		try {
			const files = source.files(job.captureId);
			guardDestination(job);
			// Keep the begin receipt observable even if the user cancels while it is
			// in flight, so the newly allocated remote partial can be cancelled by ID.
			const began = UploadBeginSchema.parse(await job.peer.request("upload.begin", { viewId: job.view.viewId, sessionId: job.view.sessionId, draftToken: job.view.draftToken, files: files.map(file => ({ name: file.name, size: file.size })) }, { timeoutMs: REQUEST_TIMEOUT }));
			job.status = { id: began.id, source: identity.device, viewId: job.view.viewId, phase: "uploading", bytesSent: 0, totalBytes: files.reduce((total, file) => total + file.size, 0), names: files.map(file => file.name) };
			transfers.set(began.id, job);
			// Receipt freshness is checked at admission; a same-draft refresh must not invalidate an admitted upload.
			guardDestination(job);
			ready.resolve(job.status);
			const sha256: string[] = [];
			let sent = 0;
			const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
			for (const [index, file] of files.entries()) {
				const input = await open(file.path, "r");
				try {
					const metadata = await input.stat();
					if (!metadata.isFile() || metadata.size !== file.size) throw new BridgeError("CAPTURE_CHANGED", "Captured file size changed before upload");
					const hash = createHash("sha256");
					let offset = 0;
					// Empty files still contribute their SHA256 digest to finish verification.
					while (offset < file.size) {
						guardDestination(job);
						const remaining = file.size - offset;
						const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, remaining), offset);
						if (bytesRead === 0) throw new BridgeError("CAPTURE_CHANGED", "Captured file was truncated during upload");
						const bytes = buffer.subarray(0, bytesRead);
						hash.update(bytes);
						const progress = UploadProgressSchema.parse(await job.peer.request("upload.chunk", { id: began.id, index, offset, data: bytes.toString("base64") }, { signal: job.controller.signal, timeoutMs: REQUEST_TIMEOUT }));
						offset += bytesRead; sent += bytesRead;
						if (progress.bytesSent !== sent) throw new BridgeError("UPLOAD_MISMATCH", "Broker acknowledged an unexpected upload byte count");
						update(job, { bytesSent: sent });
					}
					const after = await input.stat();
					if (after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs || after.ctimeMs !== metadata.ctimeMs) throw new BridgeError("CAPTURE_CHANGED", "Captured snapshot changed during upload");
					sha256.push(hash.digest("hex"));
				} finally { await input.close(); }
			}
			guardDestination(job);
			const finished = UploadFinishSchema.parse(await job.peer.request("upload.finish", { id: began.id, sha256 }, { signal: job.controller.signal, timeoutMs: REQUEST_TIMEOUT }));
			if (finished.files.length !== files.length || finished.files.some((file, index) => file.size !== files[index]!.size || file.name !== files[index]!.name || file.sha256 !== sha256[index])) throw new BridgeError("UPLOAD_MISMATCH", "Broker verification did not match the captured files");
			guardDestination(job);
			const intent = ReceiptSchema.parse(await job.peer.request("ui.intent", { kind: "attach", viewId: job.view.viewId, sessionId: job.view.sessionId, draftToken: job.view.draftToken, transferId: began.id }, { signal: job.controller.signal, timeoutMs: REQUEST_TIMEOUT }));
			guardDestination(job);
			job.intentId = intent.id;
			attachIntents.set(intent.id, job);
			update(job, { phase: "ready", frame: intent.frame });
		} catch (error) {
			const failure = error instanceof Error ? error : new Error(String(error));
			ready.reject(failure);
			update(job, { phase: "failed", frame: undefined, error: failure.message });
			try {
				await cancelRemote(job);
				if (job.controller.signal.aborted && job.controller.signal.reason instanceof BridgeError && job.controller.signal.reason.code === "CANCELLED") update(job, { phase: "cancelled" });
			} catch (cleanupError) { update(job, { error: `${failure.message}; partial cleanup could not be confirmed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}` }); }
		} finally {
			capturesInUse.delete(job.captureId);
			await source.release(job.captureId);
		}
	}
	async function cancel(job: TransferJob): Promise<void> {
		if (job.status?.phase === "attached") throw new BridgeError("ALREADY_ATTACHED", "An attachment handed to OMP cannot be cancelled as a partial upload");
		job.controller.abort(new BridgeError("CANCELLED", "The local user cancelled this transfer"));
		update(job, { frame: undefined });
		await job.done;
		try {
			await cancelRemote(job);
			if (job.intentId) attachIntents.delete(job.intentId);
			update(job, { phase: "cancelled" });
		}
		catch (error) {
			const latest = job.status ? transfers.get(job.status.id)?.status : undefined;
			if (latest?.phase !== "attached") update(job, { phase: "failed", error: `Cancellation could not be confirmed: ${error instanceof Error ? error.message : String(error)}` });
			throw error;
		}
	}

	function onEvent(owner: RpcPeer, name: string, body: unknown): void {
		if (owner !== peer || !connected) return;
		if (name === "view.resolved") {
			const view = ResolvedViewSchema.parse(body);
			if (view.state.serverInstance !== serverInstance) return;
			if (resolveIntents.get(view.viewId) !== view.resolveIntentId) return;
			if (view.state.binding.sessionId !== view.sessionId) throw new BridgeError("INVALID_STATE", "Resolved view state belongs to another session");
			views.set(view.viewId, view);
			for (const job of transfers.values()) {
				if (job.view.viewId === view.viewId && (job.view.sessionId !== view.sessionId || job.view.draftToken !== view.draftToken) && ["uploading", "ready"].includes(job.status?.phase ?? "")) {
					track(cancel(job)).catch(() => {});
					update(job, { error: "The original destination conversation or draft changed" });
				}
			}
		} else if (name === "state") {
			const event = StateEventSchema.parse(body);
			if (event.state.serverInstance !== serverInstance) return;
			if (event.state.binding.sessionId !== event.sessionId) throw new BridgeError("INVALID_STATE", "State notification belongs to another session");
			for (const [id, view] of views) if (view.sessionId === event.sessionId && (event.state.serverInstance !== view.state.serverInstance || event.state.binding.revision >= view.state.binding.revision)) views.set(id, { ...view, state: event.state });
		} else if (name === "intent.finished") {
			const event = FinishedEventSchema.parse(body);
			const job = attachIntents.get(event.id);
			if (event.kind === "attach" && job && event.viewId === job.view.viewId) {
				attachIntents.delete(event.id);
				update(job, { phase: event.error ? "failed" : "attached", frame: undefined, error: event.error });
			}
		}
	}

	async function execute(owner: RpcPeer, method: string, body: unknown, context: RpcContext): Promise<unknown> {
		if (method === "context.close") {
			await resettingContexts;
			const input = ContextCloseSchema.parse(body);
			for (const interaction of [...interactions.values()]) if (interaction.request.contextId === input.contextId) interaction.finish(null);
			await runtime.disposeContext(input.contextId);
			ownedContexts.delete(input.contextId);
			return { ok: true };
		}
		await resettingContexts;
		context.signal.throwIfAborted();
		if (owner !== peer || !connected) throw new BridgeError("NOT_REGISTERED", "Tool execution requires signed client registration");
		if (method !== "execute") throw new BridgeError("UNSUPPORTED_METHOD", "Only native tool execution and context disposal are remote methods");
		const input = ExecuteRequestSchema.parse(body);
		if (input.target.device.id !== identity.device.id || input.target.device.platform !== identity.device.platform) throw new BridgeError("WRONG_DEVICE", "This invocation targets another client device");
		if (seenCalls.has(input.target.requestId)) throw new BridgeError("DUPLICATE_REQUEST", "This invocation was already dispatched and cannot be replayed");
		if (seenCalls.size >= 100000) throw new BridgeError("CALL_LIMIT", "This service reached its invocation lifetime limit; restart explicitly before dispatching more work");
		seenCalls.add(input.target.requestId);
		const request: ExecuteRequest = { ...input, target: Object.freeze({ ...input.target, device: identity.device }) };
		const background: ToolResult[] = [];
		const delivery = typeof body === "object" && body !== null ? responseDeliveries.get(body) : undefined;
		if (!delivery) throw new BridgeError("INVALID_FRAME", "Invocation is missing its transport response ownership");
		const generation = brokerGeneration;
		ownedContexts.add(request.target.contextId);
		const deliver = (result: ToolResult) => {
			// A newly emitted completion may use a reauthenticated channel, but its
			// invocation owner never changes. Offline notifications are not queued.
			if (generation === brokerGeneration && peer && connected && !closed) peer.notify("tool.background", { requestId: request.target.requestId, result });
		};
		delivery.flush = () => { for (const result of background) deliver(result); background.length = 0; };
		return await runtime.execute(request, { signal: context.signal, onUpdate: result => context.update(result), onBackgroundResult: result => {
			if (generation !== brokerGeneration || !connected || closed) return;
			if (delivery.sent || owner !== peer) deliver(result); else background.push(result);
		} });
	}

	function connect(): void {
		if (closed) return;
		let channel: ClientTransport | undefined;
		let authenticating = false;
		let failed = false;
		const deliveries = new Map<string, ResultDelivery>();
		const owner: RpcPeer = new RpcPeer(async frame => {
			if (!channel) throw new BridgeError("CLIENT_OFFLINE", "Outbound client transport is unavailable");
			await channel.send(frame);
			if (frame.kind === "result") {
				const delivery = deliveries.get(frame.id);
				if (delivery) { deliveries.delete(frame.id); delivery.sent = true; delivery.flush?.(); }
			}
		}, (method, body, context) => execute(owner, method, body, context), (name, body) => {
			if (name !== "challenge") { onEvent(owner, name, body); return; }
			if (authenticating || connected) throw new BridgeError("INVALID_CHALLENGE", "Unexpected repeated registration challenge");
			authenticating = true;
			const { nonce } = ChallengeSchema.parse(body);
			track(owner.request("register", { device: identity.device, publicKey: identity.publicKey, signature: signIdentity(nonce, identity) }, { timeoutMs: REQUEST_TIMEOUT }).then(async value => {
				const registration = RegistrationSchema.parse(value);
				if (registration.device.id !== identity.device.id) throw new BridgeError("INVALID_IDENTITY", "Broker registered a different client identity");
				if (closed || peer !== owner || failed) return;
				clearTimeout(handshake);
				if (serverInstance !== undefined && registration.serverInstance !== serverInstance) {
					if (!resettingContexts) {
						brokerGeneration++;
						denyInteractions(); views.clear(); resolveIntents.clear(); attachIntents.clear();
						const reason = new BridgeError("BROKER_RESTARTED", "The broker restarted; old execution contexts and draft receipts were invalidated");
						const uploading = [...capturesInUse.values()];
						for (const job of uploading) job.controller.abort(reason);
						for (const job of transfers.values()) update(job, { frame: undefined, ...(job.status?.phase === "attached" || job.status?.phase === "cancelled" ? {} : { phase: "failed", error: reason.message }) });
						resettingContexts = Promise.all([
							...[...ownedContexts].map(async contextId => { await runtime.disposeContext(contextId); ownedContexts.delete(contextId); }),
							...uploading.map(job => job.done),
						]).then(() => undefined);
					}
					await resettingContexts;
					resettingContexts = undefined;
				}
				if (closed || peer !== owner || failed) return;
				serverInstance = registration.serverInstance;
				connected = true; serverName = registration.serverName;
				for (const waiter of [...connectionWaiters]) waiter.resolve();
			}).catch(disconnect));
		});
		function disconnect(error: Error): void {
			if (failed) return;
			failed = true; owner.close(error);
			if (channel) track(channel.close()).catch(() => {});
			if (peer !== owner) return;
			clearTimeout(handshake); connected = false; peer = undefined; transport = undefined;
			resolveIntents.clear(); denyInteractions();
			for (const job of transfers.values()) if (["uploading", "ready"].includes(job.status?.phase ?? "")) {
				job.controller.abort(error);
				if (job.intentId) attachIntents.delete(job.intentId);
				update(job, { phase: "failed", frame: undefined, error: "Connection lost; upload or native attachment outcome may be unknown. Nothing was replayed." });
			}
			if (!closed) reconnect = setTimeout(connect, 1000);
		}
		peer = owner;
		try {
			channel = openClientTransport(options.connection, value => {
				try {
					const frame = IncomingCallSchema.safeParse(value);
					if (frame.success && frame.data.method === "execute" && typeof frame.data.body === "object" && frame.data.body !== null) {
						const delivery: ResultDelivery = { sent: false };
						responseDeliveries.set(frame.data.body, delivery); deliveries.set(frame.data.id, delivery);
					}
					owner.receive(value);
				} catch (error) { disconnect(error instanceof Error ? error : new Error(String(error))); }
			}, disconnect);
			transport = channel;
			handshake = setTimeout(() => disconnect(new BridgeError("REGISTRATION_TIMEOUT", "The outbound relay did not complete signed registration")), REQUEST_TIMEOUT);
		} catch (error) { disconnect(error instanceof Error ? error : new Error(String(error))); }
	}

	const token = randomBytes(32).toString("hex");
	const server = Bun.serve({ hostname: "127.0.0.1", port: options.port ?? 0, maxRequestBodySize: MAX_HTTP_BYTES, idleTimeout: 30, fetch: request => track((async () => {
		if (!authorized(request, token)) return Response.json({ error: "Local UI authorization is required", code: "UNAUTHORIZED" }, { status: 401 });
		if (closed) return Response.json({ error: "Client service is closing", code: "CLIENT_CLOSED" }, { status: 503 });
		try {
			const route = new URL(request.url).pathname;
			if (request.method === "GET" && route === "/v1/state") {
				lastUiSeen = Date.now();
				const snapshot: LocalUiState = { device: identity.device, connected, serverName, views: Object.fromEntries(views), transfers: [...transfers.values()].flatMap(job => job.status ? [job.status] : []), interactions: [...interactions.values()].map(item => item.request) };
				return Response.json(snapshot);
			}
			if (request.method !== "POST") return Response.json({ error: "Unknown local UI endpoint" }, { status: 404 });
			const body = await jsonBody(request);
			if (route === "/v1/intents") {
				const input = UiIntentSchema.parse(body);
				if (input.kind === "attach") throw new BridgeError("TRANSFER_REQUIRED", "Attachment intents are created only after verified human uploads");
				const owner = requestPeer();
				const receipt = ReceiptSchema.parse(await owner.request("ui.intent", input, { signal: request.signal, timeoutMs: REQUEST_TIMEOUT }));
				if (owner !== requestPeer()) throw new BridgeError("CLIENT_OFFLINE", "The intent's original connection was lost");
				if (input.kind === "resolve") resolveIntents.set(input.viewId, receipt.id);
				return Response.json(receipt);
			}
			if (route === "/v1/captures") return Response.json(await source.capture(CaptureSchema.parse(body), request.signal));
			if (route === "/v1/captures/release") {
				const { id } = IdSchema.parse(body);
				const job = capturesInUse.get(id);
				if (job) await cancel(job); else await source.release(id);
				return Response.json({ ok: true });
			}
			if (route === "/v1/transfers") {
				const input = TransferSchema.parse(body);
				const owner = requestPeer();
				const view = views.get(input.viewId);
				if (!view || view.sessionId !== input.expectedSessionId || view.draftToken !== input.expectedDraftToken || view.resolveIntentId !== input.expectedResolveIntentId || resolveIntents.get(view.viewId) !== view.resolveIntentId) throw new BridgeError("DESTINATION_CHANGED", "The captured destination handshake no longer matches this view");
				if (capturesInUse.has(input.captureId)) throw new BridgeError("CAPTURE_BUSY", "This snapshot is already being transferred");
				if (source.files(input.captureId).some(file => isImageAttachment(file.name) || isImageAttachment(file.path))) throw new BridgeError("IMAGE_ATTACHMENT_UNSUPPORTED", "Image attachment is disabled in pure-plugin mode: the native host cannot atomically confirm the original draft. No upload or editor mutation was started.");
				const ready = Promise.withResolvers<TransferStatus>();
				const job: TransferJob = { captureId: input.captureId, view: Object.freeze({ ...view }), peer: owner, controller: new AbortController(), done: Promise.resolve() };
				source.claim(input.captureId);
				capturesInUse.set(input.captureId, job);
				job.done = track(upload(job, ready));
				void job.done.catch(error => { ready.reject(error); update(job, { phase: "failed", frame: undefined, error: error instanceof Error ? error.message : String(error) }); });
				return Response.json(await ready.promise);
			}
			if (route === "/v1/transfers/cancel") {
				const { id } = IdSchema.parse(body);
				const job = transfers.get(id);
				if (!job) throw new BridgeError("TRANSFER_MISSING", "This transfer does not belong to the client service");
				await cancel(job); return Response.json({ ok: true });
			}
			if (route === "/v1/interactions/reply") {
				const input = ReplySchema.parse(body);
				const interaction = interactions.get(input.id);
				if (!interaction) throw new BridgeError("INTERACTION_EXPIRED", "This local approval is no longer pending");
				if (input.choice !== null && !interaction.request.choices.some(choice => choice.id === input.choice)) throw new BridgeError("INVALID_CHOICE", "Choose one of the displayed local approval options");
				interaction.finish(input.choice); return Response.json({ ok: true });
			}
			return Response.json({ error: "Unknown local UI endpoint" }, { status: 404 });
		} catch (error) {
			const code = error instanceof BridgeError ? error.code : error instanceof z.ZodError ? "INVALID_INPUT" : "CLIENT_REQUEST_FAILED";
			return Response.json({ error: error instanceof z.ZodError ? "Request does not match the local UI contract" : error instanceof Error ? error.message : String(error), code }, { status: code === "CLIENT_OFFLINE" ? 503 : 400 });
		}
	})()) });
	const endpoint: Endpoint = { url: `http://127.0.0.1:${server.port}`, token, pid: process.pid };
	const controlFile = path.join(stateDir, "client.json");
	let closing: Promise<void> | undefined;
	function close(): Promise<void> {
		return closing ??= (async () => {
			closed = true; connected = false; clearTimeout(reconnect); clearTimeout(handshake); denyInteractions();
			for (const waiter of [...connectionWaiters]) waiter.reject(new BridgeError("CLIENT_CLOSED", "The client service closed before a connection became ready"));
			for (const job of capturesInUse.values()) job.controller.abort(new BridgeError("CLIENT_CLOSED", "The client service closed"));
			peer?.close();
			const results = await Promise.allSettled([server.stop(true), transport?.close(), runtime.close(), ...tasks]);
			await source.close();
			// Another service may have replaced this file. Never remove its control metadata.
			try { if ((await readEndpoint(controlFile)).token === token) await rm(controlFile, { force: true }); } catch (error) { if (!(error instanceof BridgeError && error.code === "BRIDGE_UNAVAILABLE")) throw error; }
			const rejected = results.find(result => result.status === "rejected");
			if (rejected?.status === "rejected") throw rejected.reason;
		})();
	}
	try { await writePrivateJson(controlFile, endpoint); connect(); }
	catch (error) { await close(); throw error; }
	return { endpoint, waitForConnection, close };
}
