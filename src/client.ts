// SPDX-License-Identifier: MPL-2.0
import { createHash, randomBytes } from "node:crypto";
import { open, rm } from "node:fs/promises";
import path from "node:path";
import { readImageFromClipboard, readTextFromClipboard } from "@oh-my-pi/pi-natives/clipboard";
import { z } from "zod";
import type { InteractionDecision, InteractionRequest, LocalUiState, PanelState, ResolvedView, TransferStatus, UiIntentInput, UiIntentOutcome, UiIntentReceipt } from "./api.ts";
import { assertSupportedRuntime, authorized, defaultStateDir, readEndpoint, signIdentity, writePrivateJson, type ClientIdentity, type Endpoint } from "./config.ts";
import { openClientTransport, type ClientConnection, type ClientTransport } from "./client-transport.ts";
import { BridgeError, type ExecuteRequest, type ToolResult } from "./protocol.ts";
import { ClientIdentitySchema, DeviceDescriptorSchema, ExecuteRequestSchema, IdentifierSchema, ImportedFileSchema, PanelCloseSchema, PanelPublishSchema, PanelStateSchema, ResolvedViewSchema, ServerStateSchema, UiIntentOutcomeSchema as FinishedEventSchema, UiIntentReceiptSchema as ReceiptSchema, UiIntentSchema } from "./schemas.ts";
import { OmpRuntime } from "./runtime/index.ts";
import { HumanTransferSource } from "./transfers/source.ts";
import { chooseUploadFile } from "./transfers/file-picker.ts";
import { RpcPeer, type RpcContext } from "./wire.ts";

const ChallengeSchema = z.object({ nonce: z.string().min(16).max(1024) });
const RegistrationSchema = z.object({ device: DeviceDescriptorSchema, serverName: z.string().min(1).max(256), serverInstance: IdentifierSchema });
const StateEventSchema = z.object({ sessionId: IdentifierSchema, state: ServerStateSchema });
const RevokedViewSchema = z.object({ viewId: IdentifierSchema, destinationId: IdentifierSchema, resolveIntentId: IdentifierSchema });
const ContextCloseSchema = z.object({ contextId: IdentifierSchema });
const CaptureSchema = z.object({ kind: z.literal("files"), paths: z.array(z.string().min(1).max(32768)).min(1).max(256) }).strict();
const ClipboardCaptureSchema = z.object({ kind: z.literal("clipboard") }).strict();
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
	/** Local native boundary; never accepted from HTTP or remote execution parameters. */
	readClipboardImage?: typeof readImageFromClipboard;
	readClipboardText?: typeof readTextFromClipboard;
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
	const identity: ClientIdentity = { ...parsedIdentity, device: Object.freeze({ ...parsedIdentity.device }) };
	const stateDir = options.stateDir ?? defaultStateDir();
	const source = new HumanTransferSource({ stateDir });
	const views = new Map<string, ResolvedView>();
	const resolveIntents = new Map<string, { id: string; destinationId: string }>();
	const resolving = new Map<string, object>();
	const earlyViews = new Map<string, ResolvedView>();
	const earlyFinishes = new Map<string, z.infer<typeof FinishedEventSchema>>();
	const revokedResolves = new Set<string>();
	const pendingIntents = new Set<object>();
	const admittedIntents = new Map<string, { viewId: string; kind: UiIntentInput["kind"]; expiresAt: number }>();
	const outcomes = new Map<string, UiIntentOutcome>();
	const panels = new Map<string, PanelState>();
	const panelClosures = new Map<string, number>();
	const transfers = new Map<string, TransferJob>();
	const capturesInUse = new Map<string, TransferJob>();
	const attachIntents = new Map<string, TransferJob>();
	const interactions = new Map<string, Interaction>();
	const clipboardRequests = new Set<AbortController>();
	const filePickerRequests = new Set<AbortController>();
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
	function requestInteraction(request: InteractionRequest, signal?: AbortSignal): Promise<InteractionDecision> {
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
	}
	const runtime = new OmpRuntime({ stateDir, cwd: options.cwd, onInteraction: requestInteraction });

	function update(job: TransferJob, change: Partial<TransferStatus>): void {
		if (job.status) job.status = { ...job.status, ...change };
	}
	function guardDestination(job: TransferJob): void {
		job.controller.signal.throwIfAborted();
		if (!connected || peer !== job.peer) throw new BridgeError("CLIENT_OFFLINE", "The original transfer connection is unavailable; upload was not replayed");
		const current = views.get(job.view.viewId);
		if (!current || current.destinationId !== job.view.destinationId || current.sessionId !== job.view.sessionId || current.draftToken !== job.view.draftToken) throw new BridgeError("DESTINATION_CHANGED", "The captured destination conversation or draft changed");
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
			await requestIntent(job.peer, { kind: "attach", viewId: job.view.viewId, sessionId: job.view.sessionId, draftToken: job.view.draftToken, transferId: began.id }, job.controller.signal, job);
			if (job.status?.phase !== "attached" && job.status?.phase !== "failed") guardDestination(job);
		} catch (error) {
			const failure = error instanceof Error ? error : new Error(String(error));
			ready.reject(failure);
			update(job, { phase: "failed", error: failure.message });
			try {
				await cancelRemote(job);
				if (job.controller.signal.aborted && job.controller.signal.reason instanceof BridgeError && job.controller.signal.reason.code === "CANCELLED") update(job, { phase: "cancelled" });
			} catch (cleanupError) {
				// A confirmed native handoff wins over a late partial-cleanup error.
				if (job.status?.phase !== "attached") update(job, { error: `${failure.message}; partial cleanup could not be confirmed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}` });
			}
		} finally {
			capturesInUse.delete(job.captureId);
			await source.release(job.captureId);
		}
	}
	async function cancel(job: TransferJob): Promise<void> {
		if (job.status?.phase === "attached") throw new BridgeError("ALREADY_ATTACHED", "An attachment handed to OMP cannot be cancelled as a partial upload");
		job.controller.abort(new BridgeError("CANCELLED", "The local user cancelled this transfer"));
		// Cancel promptly even while the attach receipt is in flight. Keep that
		// receipt observable so a too-late cancellation can still receive completion.
		if (!job.status) await job.done;
		try {
			await cancelRemote(job);
			await job.done;
			if (job.intentId) attachIntents.delete(job.intentId);
			update(job, { phase: "cancelled" });
		}
		catch (error) {
			await job.done;
			const latest = job.status ? transfers.get(job.status.id)?.status : undefined;
			if (latest?.phase !== "attached") update(job, { phase: "failed", error: `Cancellation could not be confirmed: ${error instanceof Error ? error.message : String(error)}` });
			throw error;
		}
	}

	function applyView(view: ResolvedView): void {
		const expected = resolveIntents.get(view.viewId);
		if (expected?.id !== view.resolveIntentId || expected.destinationId !== view.destinationId) return;
		if (view.state.binding.sessionId !== view.sessionId) throw new BridgeError("INVALID_STATE", "Resolved view state belongs to another session");
		views.set(view.viewId, view);
		for (const job of transfers.values()) if (job.view.viewId === view.viewId && (job.view.destinationId !== view.destinationId || job.view.sessionId !== view.sessionId || job.view.draftToken !== view.draftToken) && ["uploading", "ready"].includes(job.status?.phase ?? "")) {
			track(cancel(job)).catch(() => {}); update(job, { error: "The original destination conversation or draft changed" });
		}
	}
	function applyFinish(event: UiIntentOutcome): boolean {
		if (outcomes.has(event.id)) return true;
		const admitted = admittedIntents.get(event.id);
		if (!admitted) return false;
		if (admitted.viewId !== event.viewId || admitted.kind !== event.kind) return true;
		admittedIntents.delete(event.id);
		outcomes.set(event.id, event);
		if (outcomes.size > 256) outcomes.delete(outcomes.keys().next().value!);
		const job = attachIntents.get(event.id);
		if (event.kind === "attach" && job) {
			attachIntents.delete(event.id);
			update(job, { phase: event.error ? "failed" : "attached", error: event.error });
		}
		if (event.kind === "resolve" && event.error && resolveIntents.get(event.viewId)?.id === event.id) { resolveIntents.delete(event.viewId); views.delete(event.viewId); }
		return true;
	}
	function expireUiReceipts(): void {
		for (const [id, intent] of admittedIntents) if (intent.expiresAt <= Date.now()) applyFinish({ id, viewId: intent.viewId, kind: intent.kind, error: "The intent expired without a confirmed result; its outcome is unknown. Nothing was replayed." });
		for (const [key, expiresAt] of panelClosures) if (expiresAt <= Date.now()) { panelClosures.delete(key); if (panels.get(key)?.phase === "closed") panels.delete(key); }
	}
	async function requestIntent(owner: RpcPeer, input: UiIntentInput, signal: AbortSignal, job?: TransferJob): Promise<UiIntentReceipt> {
		const request = {};
		expireUiReceipts();
		if (pendingIntents.size + admittedIntents.size >= 4096) throw new BridgeError("BUSY", "Too many outstanding UI intents");
		pendingIntents.add(request);
		if (input.kind === "resolve") { resolving.set(input.viewId, request); resolveIntents.delete(input.viewId); }
		try {
			// Attachment admission can precede its reply. Aborting this wait would
			// discard the only correlation for a native handoff that already occurred.
			const receipt = ReceiptSchema.parse(await owner.request("ui.intent", input, { signal: job ? undefined : signal, timeoutMs: REQUEST_TIMEOUT }));
			if (owner !== requestPeer()) throw new BridgeError("CLIENT_OFFLINE", "The intent's original connection was lost");
			if (admittedIntents.has(receipt.id) || outcomes.has(receipt.id)) throw new BridgeError("INVALID_RECEIPT", "The broker reused an existing intent receipt");
			admittedIntents.set(receipt.id, { viewId: input.viewId, kind: input.kind, expiresAt: receipt.expiresAt });
			if (input.kind === "resolve" && resolving.get(input.viewId) === request && !revokedResolves.has(receipt.id)) {
				resolveIntents.set(input.viewId, { id: receipt.id, destinationId: input.destinationId });
				const view = earlyViews.get(receipt.id);
				if (view && view.destinationId === input.destinationId) applyView(view);
			}
			if (job) { job.intentId = receipt.id; attachIntents.set(receipt.id, job); update(job, { phase: "ready" }); }
			const finished = earlyFinishes.get(receipt.id);
			if (finished) applyFinish(finished);
			earlyViews.delete(receipt.id); earlyFinishes.delete(receipt.id);
			expireUiReceipts();
			return receipt;
		} finally {
			pendingIntents.delete(request);
			if (input.kind === "resolve" && resolving.get(input.viewId) === request) resolving.delete(input.viewId);
			if (!pendingIntents.size) { earlyViews.clear(); earlyFinishes.clear(); revokedResolves.clear(); }
		}
	}
	function onEvent(owner: RpcPeer, name: string, body: unknown): void {
		if (owner !== peer || !connected) return;
		if (name === "view.resolved") {
			const view = ResolvedViewSchema.parse(body);
			if (view.state.serverInstance !== serverInstance) return;
			if (resolveIntents.get(view.viewId)?.id === view.resolveIntentId) applyView(view);
			else if (resolving.has(view.viewId) && !revokedResolves.has(view.resolveIntentId) && earlyViews.size < 4096) earlyViews.set(view.resolveIntentId, view);
		} else if (name === "view.revoked") {
			const event = RevokedViewSchema.parse(body);
			earlyViews.delete(event.resolveIntentId);
			if (pendingIntents.size && revokedResolves.size < 4096) revokedResolves.add(event.resolveIntentId);
			if (resolveIntents.get(event.viewId)?.id === event.resolveIntentId) resolveIntents.delete(event.viewId);
			if (views.get(event.viewId)?.resolveIntentId === event.resolveIntentId) views.delete(event.viewId);
			for (const job of transfers.values()) if (job.view.destinationId === event.destinationId && ["uploading", "ready"].includes(job.status?.phase ?? "")) {
				job.controller.abort(new BridgeError("DESTINATION_CHANGED", "The native destination draft was revoked"));
				track(cancelRemote(job)).catch(() => {}); update(job, { phase: "failed", error: "The original destination draft or channel changed; nothing was replayed" });
			}
		} else if (name === "panel.state") {
			const panel = PanelStateSchema.parse(body);
			const key = JSON.stringify([panel.owner, panel.panelId]);
			panels.set(key, panel);
			if (panel.phase === "closed") panelClosures.set(key, Date.now() + 60000); else panelClosures.delete(key);
		} else if (name === "state") {
			const event = StateEventSchema.parse(body);
			if (event.state.serverInstance !== serverInstance) return;
			if (event.state.binding.sessionId !== event.sessionId) throw new BridgeError("INVALID_STATE", "State notification belongs to another session");
			for (const [id, view] of views) if (view.sessionId === event.sessionId && (event.state.serverInstance !== view.state.serverInstance || event.state.binding.revision >= view.state.binding.revision)) views.set(id, { ...view, state: event.state });
			for (const [id, view] of earlyViews) if (view.sessionId === event.sessionId && event.state.binding.revision >= view.state.binding.revision) earlyViews.set(id, { ...view, state: event.state });
		} else if (name === "intent.finished") {
			const event = FinishedEventSchema.parse(body);
			if (!applyFinish(event) && pendingIntents.size && earlyFinishes.size < 4096) earlyFinishes.set(event.id, event);
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
						denyInteractions(); views.clear(); resolveIntents.clear(); attachIntents.clear(); resolving.clear(); earlyViews.clear(); earlyFinishes.clear(); revokedResolves.clear(); panels.clear(); panelClosures.clear();
						const reason = new BridgeError("BROKER_RESTARTED", "The broker restarted; old execution contexts and draft receipts were invalidated");
						const uploading = [...capturesInUse.values()];
						for (const job of uploading) job.controller.abort(reason);
						for (const job of transfers.values()) if (job.status?.phase !== "attached" && job.status?.phase !== "cancelled") update(job, { phase: "failed", error: reason.message });
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
			for (const [id, intent] of admittedIntents) applyFinish({ id, viewId: intent.viewId, kind: intent.kind, error: "Connection lost; the intent outcome is unknown. Nothing was replayed." });
			views.clear(); resolveIntents.clear(); resolving.clear(); earlyViews.clear(); earlyFinishes.clear(); revokedResolves.clear(); denyInteractions();
			for (const [key, panel] of panels) { panels.set(key, { ...panel, phase: "closed" }); panelClosures.set(key, Date.now() + 60000); }
			for (const controller of clipboardRequests) controller.abort(error);
			for (const controller of filePickerRequests) controller.abort(error);
			for (const job of transfers.values()) if (["uploading", "ready"].includes(job.status?.phase ?? "")) {
				job.controller.abort(error);
				if (job.intentId) attachIntents.delete(job.intentId);
				update(job, { phase: "failed", error: "Connection lost; upload or native attachment outcome may be unknown. Nothing was replayed." });
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
	const server = Bun.serve({ hostname: "127.0.0.1", port: options.port ?? 0, maxRequestBodySize: MAX_HTTP_BYTES, idleTimeout: 30, fetch: (request, server) => track((async () => {
		if (!authorized(request, token)) return Response.json({ error: "Local UI authorization is required", code: "UNAUTHORIZED" }, { status: 401 });
		if (closed) return Response.json({ error: "Client service is closing", code: "CLIENT_CLOSED" }, { status: 503 });
		try {
			const route = new URL(request.url).pathname;
			if (request.method === "GET" && route === "/v1/state") {
				lastUiSeen = Date.now();
				expireUiReceipts();
				const snapshot: LocalUiState = { device: identity.device, connected, serverName, views: Object.fromEntries(views), transfers: [...transfers.values()].flatMap(job => job.status ? [job.status] : []), interactions: [...interactions.values()].map(item => item.request), panels: [...panels.values()], outcomes: [...outcomes.values()] };
				return Response.json(snapshot);
			}
			if (request.method !== "POST") return Response.json({ error: "Unknown local UI endpoint" }, { status: 404 });
			const body = await jsonBody(request);
			if (route === "/v1/intents") {
				const input = UiIntentSchema.parse(body);
				if (input.kind === "attach") throw new BridgeError("TRANSFER_REQUIRED", "Attachment intents are created only after verified human uploads");
				const owner = requestPeer();
				return Response.json(await requestIntent(owner, input, request.signal));
			}
			if (route === "/v1/panels/open" || route === "/v1/panels/publish") {
				expireUiReceipts();
				const input = PanelPublishSchema.parse(body);
				const owner = requestPeer();
				const panel = PanelStateSchema.parse(await owner.request(route === "/v1/panels/open" ? "panel.open" : "panel.publish", input, { signal: request.signal, timeoutMs: REQUEST_TIMEOUT }));
				if (owner !== requestPeer()) throw new BridgeError("CLIENT_OFFLINE", "The panel's original connection was lost");
				const key = JSON.stringify([panel.owner, panel.panelId]);
				// A host read/close may beat the paired publish receipt. Never regress its event.
				if (!panels.has(key)) panels.set(key, panel);
				return Response.json(panels.get(key));
			}
			if (route === "/v1/panels/close") {
				const input = PanelCloseSchema.parse(body);
				const owner = requestPeer();
				OkSchema.parse(await owner.request("panel.close", input, { signal: request.signal, timeoutMs: REQUEST_TIMEOUT }));
				const key = JSON.stringify([input.owner, input.panelId]); const panel = panels.get(key);
				if (panel) { panels.set(key, { ...panel, phase: "closed" }); panelClosures.set(key, Date.now() + 60000); }
				return Response.json({ ok: true });
			}
			if (route === "/v1/captures") return Response.json(await source.capture(CaptureSchema.parse(body), request.signal));
			if (route === "/v1/captures/pick-file") {
				z.object({ kind: z.literal("files") }).strict().parse(body);
				if (filePickerRequests.size) throw new BridgeError("FILE_PICKER_BUSY", "A system file chooser is already open");
				server.timeout(request, 150);
				const owner = requestPeer();
				const controller = new AbortController();
				filePickerRequests.add(controller);
				const signal = AbortSignal.any([request.signal, controller.signal]);
				try {
					const selected = await chooseUploadFile(signal);
					if (!selected) return Response.json({ cancelled: true });
					if (owner !== requestPeer()) throw new BridgeError("CLIENT_OFFLINE", "The original connection was lost while choosing a file");
					return Response.json(await source.capture({ kind: "files", paths: [selected] }, signal));
				} finally { filePickerRequests.delete(controller); }
			}
			if (route === "/v1/captures/clipboard") {
				ClipboardCaptureSchema.parse(body);
				server.timeout(request, 120);
				const owner = requestPeer();
				const controller = new AbortController();
				clipboardRequests.add(controller);
				const signal = AbortSignal.any([request.signal, controller.signal, AbortSignal.timeout(75000)]);
				async function readClipboard<T>(reader: () => Promise<T>): Promise<T> {
					signal.throwIfAborted();
					const reading = Promise.withResolvers<T>();
					const abort = () => reading.reject(signal.reason);
					signal.addEventListener("abort", abort, { once: true });
					try {
						void reader().then(reading.resolve, reading.reject);
						const value = await reading.promise;
						signal.throwIfAborted();
						if (owner !== requestPeer()) throw new BridgeError("CLIENT_OFFLINE", "The original clipboard transfer connection was lost");
						return value;
					} finally { signal.removeEventListener("abort", abort); }
				}
				try {
					// The authenticated local Paste command authorizes this capture, not native tool execution.
					signal.throwIfAborted();
					if (owner !== requestPeer()) throw new BridgeError("CLIENT_OFFLINE", "The original clipboard transfer connection was lost");
					const image = await readClipboard(options.readClipboardImage ?? readImageFromClipboard);
					if (image && image.data.byteLength > 0) {
						if (image.mimeType !== "image/png") throw new BridgeError("CLIPBOARD_IMAGE_FORMAT", "Native clipboard reader did not return PNG image bytes");
						return Response.json(await source.captureImage(image.data, signal));
					}
					const text = await readClipboard(options.readClipboardText ?? readTextFromClipboard);
					if (text === undefined || text === null || text.length === 0) throw new BridgeError("EMPTY_CLIPBOARD", "This device's clipboard contains no text or image; nothing was pasted");
					return Response.json({ kind: "text", text });
				} finally { clipboardRequests.delete(controller); }
			}
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
				if (!view || view.sessionId !== input.expectedSessionId || view.draftToken !== input.expectedDraftToken || view.resolveIntentId !== input.expectedResolveIntentId || resolveIntents.get(view.viewId)?.id !== view.resolveIntentId) throw new BridgeError("DESTINATION_CHANGED", "The captured destination handshake no longer matches this view");
				if (capturesInUse.has(input.captureId)) throw new BridgeError("CAPTURE_BUSY", "This snapshot is already being transferred");
				const ready = Promise.withResolvers<TransferStatus>();
				const job: TransferJob = { captureId: input.captureId, view: Object.freeze({ ...view }), peer: owner, controller: new AbortController(), done: Promise.resolve() };
				source.claim(input.captureId);
				capturesInUse.set(input.captureId, job);
				job.done = track(upload(job, ready));
				void job.done.catch(error => { ready.reject(error); update(job, { phase: "failed", error: error instanceof Error ? error.message : String(error) }); });
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
			for (const controller of clipboardRequests) controller.abort(new BridgeError("CLIENT_CLOSED", "The client service closed"));
			for (const controller of filePickerRequests) controller.abort(new BridgeError("CLIENT_CLOSED", "The client service closed"));
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
