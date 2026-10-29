// SPDX-License-Identifier: MPL-2.0
import path from "node:path";
import type { BackgroundResult, BrokerApi, DraftChannel, DraftDestination, ServerState, UiClaim } from "./api.ts";
import { defaultStateDir, readEndpoint, type Endpoint } from "./config.ts";
import { BridgeError, type ExecutionOptions, type ToolName, type ToolParameters, type ToolResult } from "./protocol.ts";
import { BackgroundResultSchema, DraftDestinationSchema, DraftIntentSchema, IdentifierSchema, ServerStateSchema, ToolResultSchema, UiClaimSchema } from "./schemas.ts";
import { JsonLineDecoder } from "./wire.ts";
import { z } from "zod";

const ErrorResponse = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
const StreamFrame = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("update"), result: ToolResultSchema }),
	z.object({ kind: z.literal("result"), result: ToolResultSchema }),
	z.object({ kind: z.literal("error"), error: z.object({ code: z.string(), message: z.string() }) }),
]);
const WatchFrame = z.discriminatedUnion("kind", [z.object({ kind: z.literal("state"), state: ServerStateSchema }), z.object({ kind: z.literal("background"), event: BackgroundResultSchema })]);
const DraftFrame = z.discriminatedUnion("kind", [z.object({ kind: z.literal("destination"), destination: DraftDestinationSchema }), z.object({ kind: z.literal("intent"), intent: DraftIntentSchema })]);

export class BrokerClient implements BrokerApi {
	readonly #stateDir: string;
	readonly #explicitEndpoint?: Endpoint;
	readonly #watches = new Set<() => void>();
	readonly #requests = new Set<AbortController>();
	#closed = false;

	constructor(options: { stateDir?: string; endpoint?: Endpoint } = {}) {
		this.#stateDir = options.stateDir ?? defaultStateDir();
		this.#explicitEndpoint = options.endpoint;
	}

	async #endpoint(): Promise<Endpoint> {
		if (this.#closed) throw new BridgeError("BRIDGE_CLOSED", "This bridge client is closed");
		return this.#explicitEndpoint ?? await readEndpoint(path.join(this.#stateDir, "server.json"));
	}

	async #json(route: string, body?: unknown): Promise<unknown> {
		const endpoint = await this.#endpoint();
		const response = await fetch(endpoint.url + route, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${endpoint.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
		const value: unknown = await response.json();
		if (!response.ok) {
			const error = ErrorResponse.safeParse(value);
			throw new BridgeError(error.success ? error.data.error.code : "BRIDGE_REQUEST_FAILED", error.success ? error.data.error.message : `Bridge returned HTTP ${response.status}`);
		}
		return value;
	}

	async state(sessionId: string): Promise<ServerState> {
		return ServerStateSchema.parse(await this.#json(`/v1/state?sessionId=${encodeURIComponent(sessionId)}`));
	}

	async invoke(sessionId: string, contextId: string, tool: ToolName, params: ToolParameters, options: ExecutionOptions = {}): Promise<ToolResult> {
		const endpoint = await this.#endpoint();
		const controller = new AbortController();
		this.#requests.add(controller);
		const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
		let result: ToolResult | undefined;
		let remoteError: BridgeError | undefined;
		try {
			const response = await fetch(endpoint.url + "/v1/invoke", { method: "POST", headers: { authorization: `Bearer ${endpoint.token}`, "content-type": "application/json" }, body: JSON.stringify({ sessionId, contextId, tool, params }), signal });
			if (!response.ok) {
				const parsed = ErrorResponse.safeParse(await response.json());
				throw new BridgeError(parsed.success ? parsed.data.error.code : "BRIDGE_REQUEST_FAILED", parsed.success ? parsed.data.error.message : `Bridge returned HTTP ${response.status}`);
			}
			if (!response.body) throw new BridgeError("OUTCOME_UNKNOWN", "Bridge response ended without an execution result");
			const decoder = new JsonLineDecoder(value => {
				const frame = StreamFrame.parse(value);
				if (frame.kind === "update") options.onUpdate?.(frame.result);
				else if (frame.kind === "result") result = frame.result;
				else remoteError = new BridgeError(frame.error.code, frame.error.message);
			});
			for await (const chunk of response.body) decoder.push(chunk);
			decoder.end();
			if (remoteError) throw remoteError;
			if (!result) throw new BridgeError("OUTCOME_UNKNOWN", "The connection ended before the execution result; the request was not replayed");
			return result;
		} finally { this.#requests.delete(controller); }
	}

	async claimIntent(id: string, sessionId: string, draftToken: string, destinationId: string): Promise<UiClaim> {
		return UiClaimSchema.parse(await this.#json("/v1/ui/claim", { id, sessionId, draftToken, destinationId }));
	}

	async finishIntent(id: string, error?: string): Promise<void> {
		await this.#json("/v1/ui/finish", { id, ...(error ? { error } : {}) });
	}

	openDraft(sessionId: string, draftToken: string, handlers: Parameters<BrokerApi["openDraft"]>[2]): DraftChannel {
		IdentifierSchema.parse(sessionId); IdentifierSchema.parse(draftToken);
		let stopped = false;
		let token = draftToken;
		let destination: DraftDestination | undefined;
		let socket: WebSocket | undefined;
		let reconnect: NodeJS.Timeout | undefined;
		const clear = () => { destination = undefined; handlers.onDestination(undefined); };
		const connect = async () => {
			if (stopped || this.#closed) return;
			try {
				const endpoint = await this.#endpoint();
				if (stopped || this.#closed) return;
				const url = new URL("/v1/draft", endpoint.url);
				url.protocol = "ws:"; url.searchParams.set("sessionId", sessionId); url.searchParams.set("draftToken", token);
				const initialToken = token;
				const owner = new WebSocket(url, { headers: { authorization: `Bearer ${endpoint.token}` } });
				socket = owner;
				owner.addEventListener("open", () => {
					if (!stopped && socket === owner && token !== initialToken) owner.send(JSON.stringify({ kind: "update", draftToken: token }));
				});
				owner.addEventListener("message", event => {
					if (stopped || this.#closed || socket !== owner) return;
					try {
						const frame = DraftFrame.parse(JSON.parse(String(event.data)));
						if (frame.kind === "destination") {
							if (frame.destination.draftToken !== token) return;
							destination = frame.destination; handlers.onDestination(destination);
						} else if (destination && frame.intent.destinationId === destination.id && frame.intent.sessionId === sessionId && frame.intent.draftToken === token) handlers.onIntent(frame.intent);
					} catch (error) { clear(); owner.close(1008, "Invalid draft channel message"); handlers.onError(error instanceof Error ? error : new Error(String(error))); }
				});
				owner.addEventListener("close", () => {
					if (stopped || this.#closed || socket !== owner) return;
					socket = undefined; clear();
					reconnect = setTimeout(() => { void connect(); }, 1000);
				});
				owner.addEventListener("error", () => {
					if (!stopped && !this.#closed && socket === owner) { clear(); owner.close(); handlers.onError(new BridgeError("BRIDGE_UNAVAILABLE", "The native draft channel is disconnected")); }
				});
			} catch (error) {
				if (stopped || this.#closed) return;
				clear(); handlers.onError(error instanceof Error ? error : new Error(String(error)));
				reconnect = setTimeout(() => { void connect(); }, 1000);
			}
		};
		const close = () => { if (stopped) return; stopped = true; clearTimeout(reconnect); socket?.close(); socket = undefined; clear(); this.#watches.delete(close); };
		this.#watches.add(close);
		void connect();
		return { close, update: next => {
			IdentifierSchema.parse(next);
			if (stopped || this.#closed) return;
			if (next === token) return;
			token = next; clear();
			if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ kind: "update", draftToken: token }));
		} };
	}

	watch(sessionId: string, onState: (state: ServerState) => void, onError?: (error: Error) => void, onBackgroundResult?: (event: BackgroundResult) => void): () => void {
		let stopped = false;
		let socket: WebSocket | undefined;
		let reconnect: NodeJS.Timeout | undefined;
		const connect = async () => {
			if (stopped || this.#closed) return;
			try {
				const endpoint = await this.#endpoint();
				if (stopped || this.#closed) return;
				const url = new URL("/v1/watch", endpoint.url); url.protocol = "ws:"; url.searchParams.set("sessionId", sessionId);
				const owner = new WebSocket(url, { headers: { authorization: `Bearer ${endpoint.token}` } });
				socket = owner;
				owner.addEventListener("message", event => {
					if (stopped || this.#closed || socket !== owner) return;
					try {
						const frame = WatchFrame.parse(JSON.parse(String(event.data)));
						if (frame.kind === "state") onState(frame.state);
						else onBackgroundResult?.(frame.event);
					}
					catch (error) { onError?.(error instanceof Error ? error : new Error(String(error))); }
				});
				owner.addEventListener("close", () => {
					if (stopped || this.#closed || socket !== owner) return;
					socket = undefined;
					reconnect = setTimeout(() => { void connect(); }, 1000);
				});
				owner.addEventListener("error", () => {
					if (!stopped && !this.#closed && socket === owner) onError?.(new BridgeError("BRIDGE_UNAVAILABLE", "Binding updates are temporarily disconnected"));
				});
			} catch (error) {
				if (stopped || this.#closed) return;
				onError?.(error instanceof Error ? error : new Error(String(error)));
				if (!stopped && !this.#closed) reconnect = setTimeout(() => { void connect(); }, 1000);
			}
		};
		const stop = () => { stopped = true; clearTimeout(reconnect); socket?.close(); this.#watches.delete(stop); };
		this.#watches.add(stop);
		void connect();
		return stop;
	}

	async closeContext(sessionId: string, contextId: string): Promise<void> {
		await this.#json("/v1/context/close", { sessionId, contextId });
	}

	close(): void {
		this.#closed = true;
		for (const stop of [...this.#watches]) stop();
		for (const request of this.#requests) request.abort(new BridgeError("BRIDGE_CLOSED", "The owning OMP context closed"));
		this.#requests.clear();
	}
}
