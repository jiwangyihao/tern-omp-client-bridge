// SPDX-License-Identifier: MPL-2.0
import { z } from "zod";
import { failure } from "./json.ts";
import { BridgeError, PROTOCOL_VERSION } from "./protocol.ts";

const Id = z.string().min(1).max(128);
const Failure = z.object({ code: z.string(), message: z.string() });
export const WireFrameSchema = z.discriminatedUnion("kind", [
	z.object({ v: z.literal(PROTOCOL_VERSION), kind: z.literal("request"), id: Id, seq: z.number().int().positive(), method: z.string().min(1).max(80), body: z.unknown().optional() }),
	z.object({ v: z.literal(PROTOCOL_VERSION), kind: z.literal("result"), id: Id, ok: z.boolean(), body: z.unknown().optional(), error: Failure.optional() }),
	z.object({ v: z.literal(PROTOCOL_VERSION), kind: z.literal("update"), id: Id, body: z.unknown().optional() }),
	z.object({ v: z.literal(PROTOCOL_VERSION), kind: z.literal("cancel"), id: Id }),
	z.object({ v: z.literal(PROTOCOL_VERSION), kind: z.literal("event"), name: z.string().min(1).max(80), body: z.unknown().optional() }),
]);
export type WireFrame = z.infer<typeof WireFrameSchema>;
// Transport liveness must traverse SSH and reach the Client, not stop at the relay.
export const TRANSPORT_PROBE_INTERVAL_MS = 15_000;
export const TRANSPORT_PROBE_TIMEOUT_MS = 30_000;
export const TRANSPORT_SILENCE_TIMEOUT_MS = 60_000;
export const TransportHeartbeatSchema = z.object({ nonce: z.string().uuid() });
export const TransportPingSchema = z.object({ v: z.literal(PROTOCOL_VERSION), kind: z.literal("event"), name: z.literal("transport.ping"), body: TransportHeartbeatSchema });
export interface RpcOptions { signal?: AbortSignal; timeoutMs?: number; onUpdate?: (value: unknown) => void }
export interface RpcContext { readonly signal: AbortSignal; update(value: unknown): void }
export type RpcHandler = (method: string, body: unknown, context: RpcContext) => Promise<unknown>;
type Sender = (frame: WireFrame) => void | Promise<void>;
interface Pending {
	resolve(value: unknown): void;
	reject(error: Error): void;
	cleanup(): void;
	onUpdate?: (value: unknown) => void;
	sent: boolean;
}
interface Incoming {
	id: string;
	controller: AbortController;
	finished: boolean;
	pendingUpdate?: unknown;
	updating?: Promise<void>;
}

/** FIFO request sequences reject replay; update frames carry replaceable progress snapshots. */
export class RpcPeer {
	readonly #send: Sender;
	readonly #handler?: RpcHandler;
	readonly #onEvent?: (name: string, body: unknown) => void;
	readonly #pending = new Map<string, Pending>();
	readonly #incoming = new Map<string, Incoming>();
	readonly #prefix = crypto.randomUUID();
	#sequence = 0;
	#lastIncoming = 0;
	#closed = false;

	constructor(send: Sender, handler?: RpcHandler, onEvent?: (name: string, body: unknown) => void) {
		this.#send = send;
		this.#handler = handler;
		this.#onEvent = onEvent;
	}

	request(method: string, body: unknown, options: RpcOptions = {}): Promise<unknown> {
		if (this.#closed) return Promise.reject(new BridgeError("CONNECTION_LOST", "The bridge is disconnected"));
		if (options.signal?.aborted) return Promise.reject(new BridgeError("CANCELLED", "The request was cancelled before dispatch"));
		const seq = ++this.#sequence;
		const id = `${this.#prefix}:${seq}`;
		const result = Promise.withResolvers<unknown>();
		let timer: NodeJS.Timeout | undefined;
		const cancel = () => {
			const pending = this.#pending.get(id);
			if (!pending) return;
			this.#pending.delete(id); pending.cleanup();
			pending.reject(new BridgeError("CANCELLED", "The request was cancelled; a dispatched side effect may already have occurred"));
			this.#emit({ v: PROTOCOL_VERSION, kind: "cancel", id });
		};
		const pending: Pending = { resolve: result.resolve, reject: result.reject, sent: false, onUpdate: options.onUpdate, cleanup: () => { clearTimeout(timer); options.signal?.removeEventListener("abort", cancel); } };
		this.#pending.set(id, pending);
		options.signal?.addEventListener("abort", cancel, { once: true });
		if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
			timer = setTimeout(() => {
				if (!this.#pending.delete(id)) return;
				pending.cleanup();
				pending.reject(new BridgeError("TIMEOUT", "The bridge request timed out; a dispatched outcome may be unknown"));
				this.#emit({ v: PROTOCOL_VERSION, kind: "cancel", id });
			}, options.timeoutMs);
		}
		try {
			const sent = this.#send({ v: PROTOCOL_VERSION, kind: "request", id, seq, method, body });
			pending.sent = true;
			void Promise.resolve(sent).catch(error => this.close(error instanceof Error ? error : new Error(String(error))));
		} catch (error) { this.close(error instanceof Error ? error : new Error(String(error))); }
		return result.promise;
	}

	notify(name: string, body: unknown): void {
		this.#emit({ v: PROTOCOL_VERSION, kind: "event", name, body });
	}

	receive(value: unknown): void {
		if (this.#closed) return;
		const parsed = WireFrameSchema.safeParse(value);
		if (!parsed.success) throw new BridgeError("INVALID_FRAME", "Invalid bridge protocol frame");
		const frame = parsed.data;
		if (frame.kind === "event") { this.#onEvent?.(frame.name, frame.body); return; }
		if (frame.kind === "cancel") { this.#incoming.get(frame.id)?.controller.abort(new BridgeError("CANCELLED", "The caller cancelled this operation")); return; }
		if (frame.kind === "update") { this.#pending.get(frame.id)?.onUpdate?.(frame.body); return; }
		if (frame.kind === "result") {
			const pending = this.#pending.get(frame.id);
			if (!pending) return;
			this.#pending.delete(frame.id); pending.cleanup();
			if (frame.ok) pending.resolve(frame.body);
			else pending.reject(new BridgeError(frame.error?.code ?? "INVALID_RESULT", frame.error?.message ?? "Missing remote failure details"));
			return;
		}
		if (frame.seq <= this.#lastIncoming) {
			this.#emit({ v: PROTOCOL_VERSION, kind: "result", id: frame.id, ok: false, error: { code: "DUPLICATE_REQUEST", message: "A request sequence cannot be replayed" } });
			return;
		}
		this.#lastIncoming = frame.seq;
		if (this.#incoming.size >= 128) {
			this.#emit({ v: PROTOCOL_VERSION, kind: "result", id: frame.id, ok: false, error: { code: "BUSY", message: "Too many active bridge requests" } });
			return;
		}
		const incoming: Incoming = { id: frame.id, controller: new AbortController(), finished: false };
		this.#incoming.set(frame.id, incoming);
		void this.#dispatch(frame.method, frame.body, incoming);
	}

	async #dispatch(method: string, body: unknown, incoming: Incoming): Promise<void> {
		let result: WireFrame;
		try {
			if (!this.#handler) throw new BridgeError("UNSUPPORTED_METHOD", "This endpoint does not accept requests");
			const value = await this.#handler(method, body, { signal: incoming.controller.signal, update: value => {
				if (incoming.finished || this.#closed || incoming.controller.signal.aborted) return;
				incoming.pendingUpdate = value;
				if (!incoming.updating) incoming.updating = this.#drainUpdates(incoming);
			} });
			result = { v: PROTOCOL_VERSION, kind: "result", id: incoming.id, ok: true, body: value };
		} catch (error) { result = { v: PROTOCOL_VERSION, kind: "result", id: incoming.id, ok: false, error: failure(error) }; }
		incoming.finished = true;
		await incoming.updating;
		this.#incoming.delete(incoming.id);
		this.#emit(result);
	}

	async #drainUpdates(incoming: Incoming): Promise<void> {
		try {
			while (incoming.pendingUpdate !== undefined && !this.#closed) {
				const body = incoming.pendingUpdate; incoming.pendingUpdate = undefined;
				await this.#send({ v: PROTOCOL_VERSION, kind: "update", id: incoming.id, body });
			}
		} catch (error) { this.close(error instanceof Error ? error : new Error(String(error))); }
		finally { incoming.updating = undefined; }
	}

	#emit(frame: WireFrame): void {
		if (this.#closed) return;
		try { void Promise.resolve(this.#send(frame)).catch(error => this.close(error instanceof Error ? error : new Error(String(error)))); }
		catch (error) { this.close(error instanceof Error ? error : new Error(String(error))); }
	}

	close(error: Error = new BridgeError("CONNECTION_LOST", "The bridge connection closed")): void {
		if (this.#closed) return;
		this.#closed = true;
		for (const pending of this.#pending.values()) {
			pending.cleanup();
			pending.reject(pending.sent ? new BridgeError("OUTCOME_UNKNOWN", `${error.message}; the dispatched operation was not replayed`) : error);
		}
		this.#pending.clear();
		for (const incoming of this.#incoming.values()) incoming.controller.abort(error);
		this.#incoming.clear();
	}
}

export class JsonLineDecoder {
	readonly #onValue: (value: unknown) => void;
	readonly #maxBytes: number;
	#parts: Uint8Array[] = [];
	#bytes = 0;

	constructor(onValue: (value: unknown) => void, maxBytes = 64 * 1024 * 1024) {
		this.#onValue = onValue;
		this.#maxBytes = maxBytes;
	}

	push(chunk: Uint8Array): void {
		let offset = 0;
		while (offset < chunk.length) {
			const newline = chunk.indexOf(10, offset);
			const end = newline < 0 ? chunk.length : newline;
			const part = chunk.subarray(offset, end);
			this.#bytes += part.length;
			if (this.#bytes > this.#maxBytes) { this.#parts = []; this.#bytes = 0; throw new BridgeError("FRAME_TOO_LARGE", "Bridge frame exceeds its bounded size"); }
			if (part.length) this.#parts.push(part);
			if (newline < 0) return;
			const bytes = this.#parts.length === 1 ? this.#parts[0]! : Buffer.concat(this.#parts, this.#bytes);
			this.#parts = []; this.#bytes = 0;
			let value: unknown;
			try { value = JSON.parse(new TextDecoder().decode(bytes)); }
			catch { throw new BridgeError("INVALID_FRAME", "Bridge stdout contained a non-JSON frame"); }
			this.#onValue(value);
			offset = newline + 1;
		}
	}

	end(): void {
		if (this.#bytes) throw new BridgeError("TRUNCATED_FRAME", "Bridge connection ended during a frame");
	}
}
