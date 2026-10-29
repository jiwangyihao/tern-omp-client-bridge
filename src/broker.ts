// SPDX-License-Identifier: MPL-2.0
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { Server, ServerWebSocket } from "bun";
import type { BackgroundResult, NativePanelSnapshot, PanelState, ResolvedView, ServerState, UiClaim, UiIntentInput, UiIntentReceipt } from "./api.ts";
import { assertSupportedRuntime, authorized, defaultStateDir, protectPrivatePath, verifyIdentity, writePrivateJson, type Endpoint } from "./config.ts";
import { failure } from "./json.ts";
import { BridgeError, PROTOCOL_VERSION, type DeviceDescriptor, type ExecuteRequest, type ExecutionOptions, type InvocationTarget, type ToolName, type ToolParameters, type ToolResult } from "./protocol.ts";
import { ClientResources } from "./resources/index.ts";
import { DeviceDescriptorSchema, EndpointSchema, IdentifierSchema, InvocationSchema, PanelCloseSchema, PanelPublishSchema, PanelRouteIdSchema, ToolResultSchema, UiIntentSchema } from "./schemas.ts";
import { SessionBindings } from "./session-bindings.ts";
import { UploadStore } from "./uploads.ts";
import { RpcPeer, TRANSPORT_PROBE_INTERVAL_MS, TRANSPORT_PROBE_TIMEOUT_MS, TransportHeartbeatSchema, type RpcContext } from "./wire.ts";

const RegistrationSchema = z.object({ device: DeviceDescriptorSchema, publicKey: z.string().max(4096), signature: z.string().max(1024) });
const ClaimSchema = z.object({ id: IdentifierSchema, sessionId: IdentifierSchema, draftToken: IdentifierSchema, destinationId: IdentifierSchema });
const FinishSchema = z.object({ id: IdentifierSchema, error: z.string().max(16384).optional() });
const ContextSchema = z.object({ sessionId: IdentifierSchema, contextId: IdentifierSchema });
const UploadSchema = z.object({ viewId: IdentifierSchema, sessionId: IdentifierSchema, draftToken: IdentifierSchema, files: z.array(z.object({ name: z.string().min(1).max(1024), size: z.number().int().nonnegative() })).min(1).max(256) });
const ChunkSchema = z.object({ id: IdentifierSchema, index: z.number().int().nonnegative(), offset: z.number().int().nonnegative(), data: z.string().max(349528) });
const UploadFinishSchema = z.object({ id: IdentifierSchema, sha256: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(256) });
const IdSchema = z.object({ id: IdentifierSchema });
const NativeBackgroundSchema = z.object({ requestId: IdentifierSchema, result: ToolResultSchema });
const LockSchema = z.object({ pid: z.number().int().positive(), instance: z.string() });
const NativeErrorSchema = z.object({ code: z.string() });
const DraftUpdateSchema = z.object({ kind: z.literal("update"), draftToken: IdentifierSchema }).strict();
interface Drain { promise: Promise<void>; resolve(): void; reject(reason: unknown): void }
interface ClientData { role: "client"; nonce: string; peer?: RpcPeer; device?: DeviceDescriptor; ready: boolean; timer?: NodeJS.Timeout; probe?: string; drain?: Drain }
interface WatchData { role: "watch"; sessionId: string; drain?: Drain }
interface DraftData { role: "draft"; id: string; sessionId: string; draftToken: string; drain?: Drain }
type SocketData = ClientData | WatchData | DraftData;
type Socket = ServerWebSocket<SocketData>;
interface Intent { readonly id: string; readonly clientId: string; readonly input: UiIntentInput; readonly destinationId: string; readonly sessionId: string; readonly draftToken: string; readonly expiresAt: number; phase: "pending" | "claimed" | "finished"; handedOff?: boolean }
interface UploadOwner { readonly clientId: string; readonly view: ResolvedView }
interface PanelRecord { readonly clientId: string; state: PanelState; snapshot?: NativePanelSnapshot; expiresAt: number }
interface Context { readonly sessionId: string; readonly clients: Set<string>; closing?: Promise<void> }
interface Call { readonly target: InvocationTarget; readonly controller: AbortController; phase: "running" | "completed" | "failed" | "cancelled" | "unknown"; error?: string; native?: ExecuteRequest }

/** Session routing and receipt ownership live on the agent host; execution stays on the selected client. */
class Broker {
	readonly #bindings = new SessionBindings();
	readonly #clients = new Map<string, Socket>();
	readonly #sockets = new Set<Socket>();
	readonly #views = new Map<string, Map<string, ResolvedView>>();
	readonly #intents = new Map<string, Intent>();
	readonly #drafts = new Map<string, Socket>();
	readonly #uploadOwners = new Map<string, UploadOwner>();
	readonly #panels = new Map<string, PanelRecord>();
	readonly #closedPanels = new Map<string, number>();
	readonly #contexts = new Map<string, Context>();
	readonly #calls = new Map<string, Call>();
	readonly #disposals = new Map<string, Set<string>>();
	readonly #uploads: UploadStore;
	readonly #resources = new ClientResources((request, options) => this.#execute(request, options));
	readonly #token = randomBytes(32).toString("base64url");
	readonly #instance = crypto.randomUUID();
	readonly #expiry: NodeJS.Timeout;
	#server?: Server<SocketData>;
	#closed = false;
	#close?: Promise<void>;
	#ownsLock = false;

	constructor(private readonly stateDir: string) {
		this.#uploads = new UploadStore(path.join(stateDir, "imports"));
		this.#expiry = setInterval(() => { this.#expireIntents(); this.#expirePanels(); }, 1000);
		this.#expiry.unref();
	}

	async start(port: number): Promise<Endpoint> {
		await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
		await protectPrivatePath(this.stateDir, true);
		try { await writeFile(path.join(this.stateDir, "server.lock"), JSON.stringify({ pid: process.pid, instance: this.#instance }), { flag: "wx", mode: 0o600 }); }
		catch (error) {
			if (NativeErrorSchema.safeParse(error).data?.code === "EEXIST") throw new BridgeError("BROKER_LOCKED", "A broker owns this state directory. Stop it first; after an unclean shutdown inspect server.lock and remove it only after verifying its process has exited.");
			throw error;
		}
		this.#ownsLock = true;
		await protectPrivatePath(path.join(this.stateDir, "server.lock"));
		this.#server = Bun.serve<SocketData>({
			hostname: "127.0.0.1", port, idleTimeout: 0, maxRequestBodySize: 64 * 1024 * 1024,
			fetch: (request, server) => this.#http(request, server),
			websocket: {
				maxPayloadLength: 64 * 1024 * 1024, backpressureLimit: 128 * 1024 * 1024, closeOnBackpressureLimit: true, idleTimeout: 60, sendPings: true,
				open: socket => this.#open(socket),
				message: (socket, message) => {
					try {
						const value: unknown = JSON.parse(typeof message === "string" ? message : message.toString());
						if (socket.data.role === "draft") {
							const update = DraftUpdateSchema.parse(value);
							if (update.draftToken !== socket.data.draftToken) { this.#invalidateDraft(socket.data.id); socket.data.draftToken = update.draftToken; }
							this.#draftDestination(socket);
						} else if (socket.data.role === "client") socket.data.peer?.receive(value);
						else throw new BridgeError("UNSUPPORTED_METHOD", "The binding watch is receive-only");
					} catch (error) { socket.data.role === "client" && socket.data.peer?.close(new BridgeError("INVALID_FRAME", failure(error).message)); socket.close(1008, "Invalid bridge frame"); }
				},
				drain: socket => { const drain = socket.data.drain; socket.data.drain = undefined; drain?.resolve(); },
				close: socket => this.#disconnected(socket),
			},
		});
		const endpoint: Endpoint = { url: `http://127.0.0.1:${this.#server.port}`, token: this.#token, pid: process.pid };
		await writePrivateJson(path.join(this.stateDir, "server.json"), endpoint);
		return endpoint;
	}

	#send(socket: Socket, value: unknown): Promise<void> {
		const text = JSON.stringify(value);
		if (Buffer.byteLength(text) > 64 * 1024 * 1024) return Promise.reject(new BridgeError("FRAME_TOO_LARGE", "Bridge frame exceeds 64 MiB"));
		const sent = socket.send(text);
		if (sent === 0) return Promise.reject(new BridgeError("CONNECTION_LOST", "The connection stopped accepting data"));
		if (sent > 0) return Promise.resolve();
		socket.data.drain ??= Promise.withResolvers<void>();
		return socket.data.drain.promise;
	}

	#open(socket: Socket): void {
		this.#sockets.add(socket);
		const data = socket.data;
		if (data.role === "watch") { this.#watchState(socket, data.sessionId); return; }
		if (data.role === "draft") { this.#drafts.set(data.id, socket); this.#draftDestination(socket); return; }
		data.peer = new RpcPeer(frame => this.#send(socket, frame), (method, body, context) => this.#clientRequest(socket, method, body, context), (name, body) => {
			if (name === "transport.pong") {
				const { nonce } = TransportHeartbeatSchema.parse(body);
				if (!data.probe || nonce !== data.probe) throw new BridgeError("INVALID_HEARTBEAT", "The transport response does not match this connection's pending probe");
				clearTimeout(data.timer); data.probe = undefined;
				data.timer = setTimeout(() => this.#probe(socket), TRANSPORT_PROBE_INTERVAL_MS);
				return;
			}
			if (name !== "tool.background" || !data.ready || !data.device) throw new BridgeError("UNSUPPORTED_EVENT", "Unrecognized or unauthenticated client event");
			const update = NativeBackgroundSchema.parse(body);
			const call = this.#calls.get(update.requestId);
			if (call?.target.device.id === data.device.id && call.native) {
				const event: BackgroundResult = { target: call.target, result: this.#resources.backgroundResult(call.native, update.result) };
				for (const viewer of this.#sockets) if (viewer.data.role === "watch" && viewer.data.sessionId === call.target.sessionId) void this.#send(viewer, { kind: "background", event }).catch(() => viewer.close(1011, "Background delivery interrupted"));
			}
		});
		data.timer = setTimeout(() => { this.#disconnected(socket); socket.terminate(); }, 15000);
		data.peer.notify("challenge", { nonce: data.nonce });
	}

	#probe(socket: Socket): void {
		const data = socket.data;
		if (data.role !== "client" || !this.#sockets.has(socket)) return;
		data.probe = crypto.randomUUID();
		// Only the real Client answers this nonce. WebSocket pongs from a surviving
		// relay, unrelated traffic and duplicate registrations never extend the lease.
		data.timer = setTimeout(() => { this.#disconnected(socket); socket.terminate(); }, TRANSPORT_PROBE_TIMEOUT_MS);
		data.peer?.notify("transport.ping", { nonce: data.probe });
	}

	#disconnected(socket: Socket): void {
		if (!this.#sockets.delete(socket)) return;
		socket.data.drain?.reject(new BridgeError("CONNECTION_LOST", "The connection closed under backpressure"));
		if (socket.data.role === "draft") {
			this.#drafts.delete(socket.data.id); this.#invalidateDraft(socket.data.id);
			for (const panel of this.#panels.values()) if (panel.state.destinationId === socket.data.id) this.#closePanel(panel);
			return;
		}
		if (socket.data.role !== "client") return;
		clearTimeout(socket.data.timer);
		socket.data.peer?.close();
		const id = socket.data.device?.id;
		if (id && this.#clients.get(id) === socket) {
			this.#clients.delete(id); this.#bindings.disconnect(id); this.#views.delete(id);
			for (const intent of this.#intents.values()) if (intent.clientId === id && intent.phase !== "finished") this.#finishIntent(intent, "The originating client disconnected; no action was replayed");
			for (const [uploadId, owner] of this.#uploadOwners) if (owner.clientId === id) this.#uploadOwners.delete(uploadId);
			for (const panel of this.#panels.values()) if (panel.clientId === id) this.#closePanel(panel);
			this.#broadcast();
			void this.#uploads.cancelClient(id).catch(error => console.error("Client partial-upload cleanup failed:", failure(error).message));
		}
	}

	#draftDestination(socket: Socket): void {
		if (socket.data.role !== "draft") return;
		void this.#send(socket, { kind: "destination", destination: { id: socket.data.id, serverInstance: this.#instance, draftToken: socket.data.draftToken } }).catch(() => socket.close(1011, "Draft channel interrupted"));
	}
	#draft(id: string): DraftData {
		const socket = this.#drafts.get(id);
		if (!socket || socket.readyState !== 1 || socket.data.role !== "draft") throw new BridgeError("DESTINATION_CHANGED", "The captured native OMP destination is no longer live");
		return socket.data;
	}
	#liveView(clientId: string, viewId: string, sessionId: string, draftToken?: string): ResolvedView {
		const view = this.#views.get(clientId)?.get(viewId);
		if (!view || view.sessionId !== sessionId || (draftToken !== undefined && view.draftToken !== draftToken)) throw new BridgeError("DESTINATION_CHANGED", "Resolve the exact live native OMP draft before acting");
		const draft = this.#draft(view.destinationId);
		if (draft.sessionId !== view.sessionId || draft.draftToken !== view.draftToken) throw new BridgeError("DESTINATION_CHANGED", "The original destination draft changed");
		return view;
	}
	#invalidateDraft(destinationId: string): void {
		for (const [clientId, views] of this.#views) for (const [viewId, view] of views) if (view.destinationId === destinationId) {
			views.delete(viewId);
			const socket = this.#clients.get(clientId);
			if (socket?.data.role === "client") socket.data.peer?.notify("view.revoked", { viewId, destinationId, resolveIntentId: view.resolveIntentId });
		}
		for (const intent of this.#intents.values()) if (intent.destinationId === destinationId && intent.phase !== "finished") this.#finishIntent(intent, "The original destination draft or channel changed; no action was replayed");
		for (const [id, owner] of this.#uploadOwners) if (owner.view.destinationId === destinationId) {
			this.#uploadOwners.delete(id);
			void this.#uploads.cancel(owner.clientId, id).catch(error => console.error("Draft partial-upload cleanup failed:", failure(error).message));
		}
	}
	#uploadOwner(clientId: string, id: string): UploadOwner {
		const owner = this.#uploadOwners.get(id);
		if (!owner || owner.clientId !== clientId) throw new BridgeError("DESTINATION_CHANGED", "The upload's original draft admission is no longer valid");
		const view = this.#liveView(clientId, owner.view.viewId, owner.view.sessionId, owner.view.draftToken);
		if (view.destinationId !== owner.view.destinationId) throw new BridgeError("DESTINATION_CHANGED", "The upload cannot move to a replacement draft channel");
		return owner;
	}
	#panelKey(clientId: string, owner: string, panelId: string): string { return JSON.stringify([clientId, owner, panelId]); }
	#panelState(panel: PanelRecord): void {
		const socket = this.#clients.get(panel.clientId);
		if (socket?.data.role === "client" && socket.data.ready) socket.data.peer?.notify("panel.state", panel.state);
	}
	#closePanel(panel: PanelRecord): void {
		if (panel.state.phase === "closed") return;
		const key = this.#panelKey(panel.clientId, panel.state.owner, panel.state.panelId);
		this.#panels.delete(key); this.#closedPanels.set(key, Date.now() + 60000);
		panel.state = { ...panel.state, phase: "closed" }; panel.snapshot = undefined;
		this.#panelState(panel);
	}
	#expirePanels(): void {
		for (const panel of this.#panels.values()) if (panel.expiresAt <= Date.now()) this.#closePanel(panel);
		for (const [key, expiresAt] of this.#closedPanels) if (expiresAt <= Date.now()) this.#closedPanels.delete(key);
	}
	#openPanel(clientId: string, input: z.infer<typeof PanelPublishSchema>): PanelState {
		this.#expirePanels(); this.#draft(input.destinationId);
		const key = this.#panelKey(clientId, input.owner, input.panelId);
		if (this.#panels.has(key) || this.#closedPanels.has(key)) throw new BridgeError("PANEL_CLOSED", "This panel instance was already opened or closed; choose a new instance");
		if (this.#panels.size >= 4096 || this.#panels.size + this.#closedPanels.size >= 8192) throw new BridgeError("BUSY", "Active panels or their temporary closure quarantine reached the admission limit");
		const panel: PanelRecord = { clientId, state: { owner: input.owner, panelId: input.panelId, destinationId: input.destinationId, phase: "waiting" }, snapshot: input.snapshot, expiresAt: Date.now() + 15000 };
		this.#panels.set(key, panel); this.#panelState(panel);
		return panel.state;
	}
	#publishPanel(clientId: string, input: z.infer<typeof PanelPublishSchema>): PanelState {
		this.#expirePanels(); this.#draft(input.destinationId);
		const panel = this.#panels.get(this.#panelKey(clientId, input.owner, input.panelId));
		if (!panel || panel.state.destinationId !== input.destinationId) throw new BridgeError("PANEL_CLOSED", "Publishing cannot create, revive, or retarget a panel; explicitly open a new instance");
		panel.snapshot = input.snapshot; panel.expiresAt = Date.now() + 15000;
		this.#panelState(panel);
		return panel.state;
	}

	#state(sessionId: string): ServerState { return { serverInstance: this.#instance, binding: this.#bindings.state(sessionId), devices: this.#bindings.devices() }; }
	#watchState(socket: Socket, sessionId: string): void {
		void this.#send(socket, { kind: "state", state: this.#state(sessionId) }).catch(() => socket.close(1011, "State delivery interrupted"));
	}
	#broadcast(sessionId?: string): void {
		for (const socket of this.#sockets) if (socket.data.role === "watch" && (!sessionId || socket.data.sessionId === sessionId)) this.#watchState(socket, socket.data.sessionId);
		for (const [clientId, views] of this.#views) {
			const socket = this.#clients.get(clientId);
			if (socket?.data.role !== "client" || !socket.data.ready) continue;
			const sessions = new Set([...views.values()].map(view => view.sessionId));
			for (const id of sessions) if (!sessionId || id === sessionId) socket.data.peer?.notify("state", { sessionId: id, state: this.#state(id) });
		}
	}

	async #clientRequest(socket: Socket, method: string, body: unknown, context: RpcContext): Promise<unknown> {
		if (this.#closed || socket.data.role !== "client") throw new BridgeError("BRIDGE_CLOSED", "The client channel is closed");
		const data = socket.data;
		if (method === "register") {
			if (data.device) throw new BridgeError("ALREADY_REGISTERED", "A channel can register only once");
			const input = RegistrationSchema.parse(body);
			if (!verifyIdentity(data.nonce, input.device, input.publicKey, input.signature)) throw new BridgeError("INVALID_IDENTITY", "The client did not prove ownership of its identity key");
			if (this.#clients.has(input.device.id)) throw new BridgeError("DUPLICATE_CLIENT", "Another connection already owns this client identity");
			data.device = input.device; this.#clients.set(input.device.id, socket);
			const pending = this.#disposals.get(input.device.id);
			if (pending) for (const contextId of pending) { await data.peer!.request("context.close", { contextId }, { signal: context.signal, timeoutMs: 15000 }); pending.delete(contextId); }
			context.signal.throwIfAborted();
			data.ready = true; clearTimeout(data.timer);
			data.timer = setTimeout(() => this.#probe(socket), TRANSPORT_PROBE_INTERVAL_MS);
			this.#bindings.connect(input.device); this.#broadcast();
			return { device: input.device, serverName: os.hostname(), serverInstance: this.#instance };
		}
		if (!data.ready || !data.device) throw new BridgeError("AUTHENTICATION_REQUIRED", "Register a signed client identity first");
		const clientId = data.device.id;
		if (method === "ui.intent") return this.#createIntent(clientId, UiIntentSchema.parse(body));
		if (method === "panel.open") return this.#openPanel(clientId, PanelPublishSchema.parse(body));
		if (method === "panel.publish") return this.#publishPanel(clientId, PanelPublishSchema.parse(body));
		if (method === "panel.close") {
			const input = PanelCloseSchema.parse(body);
			const panel = this.#panels.get(this.#panelKey(clientId, input.owner, input.panelId));
			if (panel) this.#closePanel(panel);
			return { ok: true };
		}
		if (method === "upload.begin") {
			const input = UploadSchema.parse(body);
			const view = this.#liveView(clientId, input.viewId, input.sessionId, input.draftToken);
			context.signal.throwIfAborted();
			const result = await this.#uploads.begin(clientId, input);
			try {
				context.signal.throwIfAborted();
				if (this.#clients.get(clientId) !== socket) throw new BridgeError("CLIENT_OFFLINE", "The upload's original client disconnected");
				const current = this.#liveView(clientId, input.viewId, input.sessionId, input.draftToken);
				if (current.destinationId !== view.destinationId) throw new BridgeError("DESTINATION_CHANGED", "The original draft channel was replaced during upload admission");
				this.#uploadOwners.set(result.id, { clientId, view });
			} catch (error) { await this.#uploads.cancel(clientId, result.id); throw error; }
			return result;
		}
		if (method === "upload.chunk") {
			const input = ChunkSchema.parse(body); this.#uploadOwner(clientId, input.id);
			const result = await this.#uploads.chunk(clientId, input, context.signal); this.#uploadOwner(clientId, input.id); return result;
		}
		if (method === "upload.finish") {
			const input = UploadFinishSchema.parse(body); this.#uploadOwner(clientId, input.id);
			const result = await this.#uploads.finish(clientId, input.id, input.sha256); this.#uploadOwner(clientId, input.id); return { files: result.files };
		}
		if (method === "upload.cancel") {
			const id = IdSchema.parse(body).id;
			const intents = [...this.#intents.values()].filter(intent => intent.clientId === clientId && intent.input.kind === "attach" && intent.input.transferId === id);
			if (intents.some(intent => intent.handedOff)) throw new BridgeError("CANCEL_TOO_LATE", "OMP already claimed these files; attachment may be queued. Cancellation is unconfirmed and verified assets are retained.");
			for (const intent of intents) if (intent.phase === "pending") this.#finishIntent(intent, "The transfer was cancelled before OMP claimed its attachment");
			if (this.#uploadOwners.get(id)?.clientId === clientId) this.#uploadOwners.delete(id);
			await this.#uploads.cancel(clientId, id);
			return { ok: true };
		}
		throw new BridgeError("UNSUPPORTED_METHOD", `Unknown paired-client method: ${method}`);
	}

	#expireIntents(): void {
		for (const [id, intent] of this.#intents) if (intent.expiresAt <= Date.now()) {
			if (intent.phase !== "finished") this.#finishIntent(intent, "The local UI intent expired before completion; no action was replayed");
			this.#intents.delete(id);
		}
	}
	#createIntent(clientId: string, input: UiIntentInput): UiIntentReceipt {
		this.#expireIntents();
		if (this.#intents.size >= 4096) throw new BridgeError("BUSY", "Too many pending UI receipts");
		const view = input.kind === "resolve" ? undefined : this.#liveView(clientId, input.viewId, input.sessionId, input.draftToken);
		const destinationId = input.kind === "resolve" ? input.destinationId : view!.destinationId;
		const draft = this.#draft(destinationId);
		if (input.kind === "attach") {
			const owner = this.#uploadOwner(clientId, input.transferId);
			if (owner.view.viewId !== input.viewId || owner.view.destinationId !== destinationId) throw new BridgeError("DESTINATION_CHANGED", "Uploaded files belong to another destination");
			this.#uploads.completed(clientId, input.transferId);
		}
		if (input.kind === "resolve") for (const old of this.#intents.values()) if (old.clientId === clientId && old.input.kind === "resolve" && old.input.viewId === input.viewId && old.phase === "pending") this.#finishIntent(old, "A newer destination resolution superseded this request");
		const id = randomBytes(24).toString("base64url");
		const expiresAt = Date.now() + 60000;
		const intent: Intent = { id, clientId, input, destinationId, sessionId: draft.sessionId, draftToken: draft.draftToken, expiresAt, phase: "pending" };
		this.#intents.set(id, intent);
		const socket = this.#drafts.get(destinationId)!;
		void this.#send(socket, { kind: "intent", intent: { id, destinationId, sessionId: draft.sessionId, draftToken: draft.draftToken } }).catch(() => {
			this.#finishIntent(intent, "The native draft channel disconnected before delivery; no action was replayed"); socket.close(1011, "Draft delivery interrupted");
		});
		return { id, expiresAt };
	}
	#claimIntent(input: z.infer<typeof ClaimSchema>): UiClaim {
		const intent = this.#intents.get(input.id);
		if (!intent || intent.expiresAt <= Date.now()) throw new BridgeError("INTENT_EXPIRED", "The local UI intent is missing or expired");
		if (intent.phase !== "pending") throw new BridgeError("INTENT_CONSUMED", "A local UI intent can be consumed only once");
		if (input.destinationId !== intent.destinationId || input.sessionId !== intent.sessionId || input.draftToken !== intent.draftToken) throw new BridgeError("DESTINATION_CHANGED", "The intent belongs to another native OMP draft channel");
		const draft = this.#draft(input.destinationId);
		if (draft.sessionId !== input.sessionId || draft.draftToken !== input.draftToken) throw new BridgeError("DESTINATION_CHANGED", "The original native OMP draft changed");
		const socket = this.#clients.get(intent.clientId);
		if (socket?.data.role !== "client" || !socket.data.ready) throw new BridgeError("CLIENT_OFFLINE", "The originating view disconnected");
		intent.phase = "claimed";
		try {
			const operation = intent.input;
			if (operation.kind === "resolve") {
				let views = this.#views.get(intent.clientId);
				if (!views) { views = new Map(); this.#views.set(intent.clientId, views); }
				const view: ResolvedView = { viewId: operation.viewId, resolveIntentId: intent.id, destinationId: input.destinationId, sessionId: input.sessionId, draftToken: input.draftToken, state: this.#state(input.sessionId) };
				views.set(operation.viewId, view); socket.data.peer?.notify("view.resolved", view);
			} else {
				const view = this.#liveView(intent.clientId, operation.viewId, input.sessionId, input.draftToken);
				if (view.destinationId !== input.destinationId) throw new BridgeError("DESTINATION_CHANGED", "The view moved to another native OMP channel");
				if (operation.kind === "bind") { this.#bindings.select(input.sessionId, intent.clientId, operation.clientId, operation.expectedRevision); this.#broadcast(input.sessionId); }
				else if (operation.kind === "attach") {
					this.#uploadOwner(intent.clientId, operation.transferId);
					const uploaded = this.#uploads.completed(intent.clientId, operation.transferId); intent.handedOff = true;
					return { id: intent.id, kind: "attach", state: this.#state(input.sessionId), files: uploaded.files };
				} else return { id: intent.id, kind: "paste", state: this.#state(input.sessionId), text: operation.text };
			}
			return { id: intent.id, kind: operation.kind, state: this.#state(input.sessionId) };
		} catch (error) { this.#finishIntent(intent, failure(error).message); throw error; }
	}
	#finishIntent(intent: Intent, error?: string): void {
		if (intent.phase === "finished") return;
		intent.phase = "finished";
		const socket = this.#clients.get(intent.clientId);
		if (socket?.data.role === "client") socket.data.peer?.notify("intent.finished", { id: intent.id, viewId: intent.input.viewId, kind: intent.input.kind, ...(error ? { error } : {}) });
	}

	async #execute(request: ExecuteRequest, options: ExecutionOptions = {}): Promise<ToolResult> {
		const socket = this.#clients.get(request.target.device.id);
		if (socket?.data.role !== "client" || !socket.data.ready || !socket.data.peer) throw new BridgeError("CLIENT_OFFLINE", "The captured client is offline; execution was not redirected");
		const call = this.#calls.get(request.target.requestId);
		if (call) call.native = { target: request.target, tool: request.tool, params: typeof request.params.path === "string" ? { path: request.params.path } : {} };
		return ToolResultSchema.parse(await socket.data.peer.request("execute", request, { signal: options.signal, onUpdate: value => options.onUpdate?.(ToolResultSchema.parse(value)) }));
	}

	async #invoke(sessionId: string, contextId: string, tool: ToolName, params: ToolParameters, signal: AbortSignal, onUpdate: (result: ToolResult) => void): Promise<ToolResult> {
		if (typeof params.path === "string" && params.path.startsWith("proc://client-bridge-call/")) {
			const match = /^proc:\/\/client-bridge-call\/([a-f0-9-]+)(\/cancel)?$/.exec(params.path);
			const call = match && this.#calls.get(match[1]!);
			if (!call || call.target.sessionId !== sessionId || call.target.contextId !== contextId) throw new BridgeError("CALL_UNAVAILABLE", "This execution receipt belongs to no active call in this context");
			if (tool === "write" && match![2]) {
				if (call.phase !== "running") throw new BridgeError("CALL_NOT_RUNNING", "The initial call finished; control any native background job through its own returned handle");
				call.controller.abort(new BridgeError("CANCELLED", "Cancellation requested through the original call receipt"));
			} else if (tool !== "read" || match![2]) throw new BridgeError("INVALID_CALL_OPERATION", "Read the receipt, or write its /cancel path");
			return { content: [{ type: "text", text: JSON.stringify({ requestId: call.target.requestId, client: call.target.device, phase: call.phase, error: call.error }) }], details: { target: call.target, phase: call.phase } };
		}
		let context = this.#contexts.get(contextId);
		if (context && context.sessionId !== sessionId) throw new BridgeError("CONTEXT_OWNER_MISMATCH", "An execution context cannot be moved to another conversation");
		if (context?.closing) throw new BridgeError("CONTEXT_CLOSING", "The execution context is closing");
		if (!context) { context = { sessionId, clients: new Set() }; this.#contexts.set(contextId, context); }
		const requestId = crypto.randomUUID();
		const owned = typeof params.path === "string" ? this.#resources.resolveOwnedHandle(sessionId, contextId, params.path, requestId) : null;
		const target = owned?.target ?? this.#bindings.capture(sessionId, contextId, requestId);
		context.clients.add(target.device.id);
		const controller = new AbortController();
		const call: Call = { target, controller, phase: "running" };
		this.#calls.set(requestId, call);
		try {
			const result = await this.#resources.execute({ target, tool, params }, { signal: AbortSignal.any([signal, controller.signal]), onUpdate });
			call.phase = "completed";
			return result;
		} catch (error) {
			const cause = failure(error);
			call.phase = cause.code === "OUTCOME_UNKNOWN" ? "unknown" : cause.code === "CANCELLED" ? "cancelled" : "failed";
			call.error = cause.message;
			throw new BridgeError(cause.code, `${cause.message}. Original-device receipt: proc://client-bridge-call/${requestId}`);
		}
	}

	async #closeContext(sessionId: string, contextId: string): Promise<void> {
		const context = this.#contexts.get(contextId);
		if (!context) return;
		if (context.sessionId !== sessionId) throw new BridgeError("CONTEXT_OWNER_MISMATCH", "Cannot close another conversation's execution context");
		if (context.closing) return context.closing;
		this.#resources.forgetContext(contextId);
		for (const [id, call] of this.#calls) if (call.target.contextId === contextId) { call.controller.abort(new BridgeError("CONTEXT_CLOSED", "The owning execution context closed")); this.#calls.delete(id); }
		context.closing = (async () => {
			const errors: unknown[] = [];
			for (const clientId of context.clients) {
				let pending = this.#disposals.get(clientId);
				if (!pending) { pending = new Set(); this.#disposals.set(clientId, pending); }
				pending.add(contextId);
				const socket = this.#clients.get(clientId);
				if (socket?.data.role === "client" && socket.data.ready && socket.data.peer) {
					try { await socket.data.peer.request("context.close", { contextId }, { timeoutMs: 15000 }); pending.delete(contextId); }
					catch (error) { errors.push(error); }
				}
			}
			this.#contexts.delete(contextId);
			if (errors.length) throw new AggregateError(errors, "Some client contexts could not be closed; disposal will be retried on authenticated reconnect");
		})();
		return context.closing;
	}

	async #http(request: Request, server: Server<SocketData>): Promise<Response | undefined> {
		try {
			if (!authorized(request, this.#token)) return Response.json({ error: { code: "UNAUTHORIZED", message: "A private local bridge credential is required; browser origins are not accepted" } }, { status: 401 });
			if (this.#closed) throw new BridgeError("BRIDGE_CLOSED", "The bridge is shutting down");
			const url = new URL(request.url);
			if (request.method === "GET" && url.pathname === "/v1/connect") {
				if (server.upgrade(request, { data: { role: "client", nonce: randomBytes(32).toString("base64url"), ready: false } })) return;
				return new Response("WebSocket upgrade required", { status: 426 });
			}
			if (request.method === "GET" && url.pathname === "/v1/watch") {
				const sessionId = IdentifierSchema.parse(url.searchParams.get("sessionId"));
				if (server.upgrade(request, { data: { role: "watch", sessionId } })) return;
				return new Response("WebSocket upgrade required", { status: 426 });
			}
			if (request.method === "GET" && url.pathname === "/v1/draft") {
				const sessionId = IdentifierSchema.parse(url.searchParams.get("sessionId"));
				const draftToken = IdentifierSchema.parse(url.searchParams.get("draftToken"));
				if (server.upgrade(request, { data: { role: "draft", id: randomBytes(24).toString("base64url"), sessionId, draftToken } })) return;
				return new Response("WebSocket upgrade required", { status: 426 });
			}
			if (request.method === "GET" && url.pathname === "/v1/panels") {
				this.#expirePanels();
				const clientId = IdentifierSchema.parse(url.searchParams.get("clientId"));
				const owner = PanelRouteIdSchema.parse(url.searchParams.get("owner"));
				const panelId = PanelRouteIdSchema.parse(url.searchParams.get("panelId"));
				const panel = this.#panels.get(this.#panelKey(clientId, owner, panelId));
				if (!panel || panel.state.phase === "closed") return Response.json({ closed: true });
				try { this.#draft(panel.state.destinationId); } catch { this.#closePanel(panel); return Response.json({ closed: true }); }
				if (panel.state.phase === "waiting") { panel.state = { ...panel.state, phase: "ready" }; this.#panelState(panel); }
				return Response.json({ closed: false, snapshot: panel.snapshot }, { headers: { "cache-control": "no-store" } });
			}
			if (request.method === "GET" && url.pathname === "/v1/health") return Response.json({ ok: true, protocol: PROTOCOL_VERSION });
			if (request.method === "GET" && url.pathname === "/v1/state") return Response.json(this.#state(IdentifierSchema.parse(url.searchParams.get("sessionId"))));
			if (request.method !== "POST") return new Response("Not found", { status: 404 });
			const body: unknown = await request.json();
			if (url.pathname === "/v1/ui/claim") return Response.json(this.#claimIntent(ClaimSchema.parse(body)));
			if (url.pathname === "/v1/panels/closed") {
				const input = PanelCloseSchema.extend({ clientId: IdentifierSchema }).parse(body);
				const panel = this.#panels.get(this.#panelKey(input.clientId, input.owner, input.panelId));
				if (panel) this.#closePanel(panel);
				return Response.json({ ok: true });
			}
			if (url.pathname === "/v1/ui/finish") {
				const input = FinishSchema.parse(body); const intent = this.#intents.get(input.id);
				if (!intent || intent.phase === "pending") throw new BridgeError("INTENT_UNCLAIMED", "Only a consumed UI intent can be completed");
				if (intent.phase === "finished") throw new BridgeError("INTENT_CONSUMED", "This intent already has a completion receipt");
				if (intent.expiresAt <= Date.now()) { this.#finishIntent(intent, "The intent expired before completion"); throw new BridgeError("INTENT_EXPIRED", "The intent expired before completion"); }
				const draft = this.#draft(intent.destinationId);
				if (draft.sessionId !== intent.sessionId || draft.draftToken !== intent.draftToken) throw new BridgeError("DESTINATION_CHANGED", "The original native draft changed before completion");
				this.#finishIntent(intent, input.error); return Response.json({ ok: true });
			}
			if (url.pathname === "/v1/context/close") { const input = ContextSchema.parse(body); await this.#closeContext(input.sessionId, input.contextId); return Response.json({ ok: true }); }
			if (url.pathname === "/v1/invoke") {
				const input = InvocationSchema.parse(body);
				const abort = new AbortController();
				let writable = true;
				let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
				let update: ToolResult | undefined;
				let terminal: { kind: "result"; result: ToolResult } | { kind: "error"; error: { code: string; message: string } } | undefined;
				let flushing = false;
				const flush = () => {
					if (flushing || !writable || !controller) return;
					flushing = true;
					try {
						const output = controller;
						if (update && (output.desiredSize ?? 0) > 0) {
							const current = update; update = undefined;
							output.enqueue(Buffer.from(JSON.stringify({ kind: "update", result: current }) + "\n"));
						}
						if (terminal && writable && (output.desiredSize ?? 0) > 0) {
							const final = terminal; terminal = undefined;
							writable = false; controller = undefined;
							output.enqueue(Buffer.from(JSON.stringify(final) + "\n"));
							if (!abort.signal.aborted) output.close();
						}
					} finally { flushing = false; }
				};
				const stream = new ReadableStream<Uint8Array>({
					start: output => {
						controller = output;
						void this.#invoke(input.sessionId, input.contextId, input.tool, input.params, AbortSignal.any([request.signal, abort.signal]), result => { update = result; flush(); })
							.then(result => { terminal = { kind: "result", result }; flush(); }, error => { terminal = { kind: "error", error: error instanceof z.ZodError ? { code: "INVALID_REQUEST", message: error.message } : failure(error) }; flush(); });
					},
					pull: flush,
					cancel: () => { writable = false; controller = undefined; update = undefined; terminal = undefined; abort.abort(new BridgeError("CANCELLED", "The OMP caller stopped receiving this invocation")); },
				});
				return new Response(stream, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
			}
			return new Response("Not found", { status: 404 });
		} catch (error) {
			const value = error instanceof z.ZodError ? { code: "INVALID_REQUEST", message: error.message } : failure(error);
			return Response.json({ error: value }, { status: value.code === "INVALID_REQUEST" || value.code === "DESTINATION_CHANGED" ? 400 : 409 });
		}
	}

	close(): Promise<void> {
		if (this.#close) return this.#close;
		this.#closed = true; clearInterval(this.#expiry);
		this.#close = (async () => {
			const results = await Promise.allSettled([...this.#contexts].map(([id, context]) => this.#closeContext(context.sessionId, id)));
			for (const socket of this.#sockets) { if (socket.data.role === "client") socket.data.peer?.close(); socket.close(1001, "Broker stopped"); }
			await this.#server?.stop(true);
			const uploadCleanup = await Promise.allSettled([this.#uploads.close()]);
			if (this.#ownsLock) {
				try {
					const file = path.join(this.stateDir, "server.json");
					const endpoint = EndpointSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
					if (endpoint.success && endpoint.data.token === this.#token) await rm(file);
				} catch (error) { if (NativeErrorSchema.safeParse(error).data?.code !== "ENOENT") throw error; }
				const lock = LockSchema.parse(JSON.parse(await readFile(path.join(this.stateDir, "server.lock"), "utf8")));
				if (lock.instance === this.#instance) await rm(path.join(this.stateDir, "server.lock"));
			}
			const errors = [...results, ...uploadCleanup].flatMap(result => result.status === "rejected" ? [result.reason] : []);
			if (errors.length) throw new AggregateError(errors, "Broker stopped with client cleanup errors");
		})();
		return this.#close;
	}
}

export async function startBroker(options: { stateDir?: string; port?: number } = {}): Promise<{ endpoint: Endpoint; close(): Promise<void> }> {
	assertSupportedRuntime();
	const broker = new Broker(path.resolve(options.stateDir ?? defaultStateDir()));
	try { const endpoint = await broker.start(options.port ?? 0); return { endpoint, close: () => broker.close() }; }
	catch (error) { await broker.close(); throw error; }
}
