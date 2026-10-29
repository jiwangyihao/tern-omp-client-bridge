// SPDX-License-Identifier: MPL-2.0
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { assertSupportedRuntime, defaultStateDir, readEndpoint } from "./config.ts";
import { BridgeError } from "./protocol.ts";
import { JsonLineDecoder, WireFrameSchema } from "./wire.ts";

const MAX_BYTES = 64 * 1024 * 1024;
const LOW_WATER_BYTES = 1024 * 1024;

/** One authenticated channel, never a reconnecting/replaying proxy. Stdout is protocol only. */
export async function runRelay(options: {
	stateDir?: string;
	signal?: AbortSignal;
	input?: Readable;
	output?: Writable;
} = {}): Promise<void> {
	assertSupportedRuntime();
	options.signal?.throwIfAborted();
	const endpoint = await readEndpoint(path.join(options.stateDir ?? defaultStateDir(), "server.json"));
	options.signal?.throwIfAborted();
	const url = new URL("/v1/connect", endpoint.url);
	url.protocol = "ws:";
	const input = options.input ?? process.stdin;
	const output = options.output ?? process.stdout;
	const done = Promise.withResolvers<void>();
	const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${endpoint.token}` } });
	let finished = false;
	let finishError: Error | undefined;
	let inputEnded = false;
	let pendingWrites = 0;
	let drainTimer: NodeJS.Timeout | undefined;
	let closeTimer: NodeJS.Timeout | undefined;
	let drainDeadline: NodeJS.Timeout | undefined;
	const connectTimer = setTimeout(() => finish(new BridgeError("CONNECT_TIMEOUT", "Relay could not connect to the agent-host server")), 15_000);

	function settle(): void {
		clearTimeout(closeTimer);
		if (finishError) done.reject(finishError);
		else done.resolve();
	}

	function finish(error?: Error): void {
		if (finished) return;
		finished = true;
		finishError = error;
		clearTimeout(connectTimer);
		clearInterval(drainTimer);
		clearTimeout(drainDeadline);
		input.pause();
		input.off("data", onData);
		input.off("end", onEnd);
		input.off("error", onInputError);
		input.off("close", onInputClose);
		if (error) { input.destroy(); output.destroy(); }
		if (pendingWrites === 0) setImmediate(() => {
			output.off("error", onOutputError);
			output.off("close", onOutputClose);
		});
		options.signal?.removeEventListener("abort", onAbort);
		// Completion owns the socket lifetime, not just the call to close(). In-process
		// callers may immediately stop the broker once this promise settles.
		if (socket.readyState === WebSocket.OPEN) {
			closeTimer = setTimeout(() => { socket.terminate(); settle(); }, 1000);
			socket.close(error ? 4000 : 1000);
		} else if (socket.readyState === WebSocket.CONNECTING) {
			// A handshake has no close frame to exchange.
			socket.terminate();
			settle();
		} else if (socket.readyState === WebSocket.CLOSED) {
			settle();
		} else {
			closeTimer = setTimeout(() => { socket.terminate(); settle(); }, 1000);
		}
	}

	function drain(): void {
		if (finished) return;
		if (inputEnded && (socket.readyState === WebSocket.CLOSED || socket.bufferedAmount === 0) && pendingWrites === 0) {
			finish();
			return;
		}
		if (!inputEnded && socket.readyState === WebSocket.OPEN && socket.bufferedAmount <= LOW_WATER_BYTES) {
			clearInterval(drainTimer);
			drainTimer = undefined;
			input.resume();
		}
	}

	function waitForDrain(): void {
		input.pause();
		drainTimer ??= setInterval(drain, 10);
	}

	function endDrain(): void {
		inputEnded = true;
		drainDeadline ??= setTimeout(() => finish(new BridgeError("DRAIN_TIMEOUT", "Relay could not drain its closing channel; operation outcomes may be unknown, nothing was replayed")), 5000);
		waitForDrain();
		drain();
	}

	const decoder = new JsonLineDecoder(value => {
		const parsed = WireFrameSchema.safeParse(value);
		if (!parsed.success) throw new BridgeError("INVALID_FRAME", "Relay stdin contained an invalid wire frame");
		const frame = JSON.stringify(parsed.data);
		if (socket.readyState !== WebSocket.OPEN) throw new BridgeError("CONNECTION_LOST", "Relay WebSocket is not open");
		if (socket.bufferedAmount + Buffer.byteLength(frame) > MAX_BYTES) throw new BridgeError("BACKPRESSURE", "Relay WebSocket queue exceeded its bounded size");
		socket.send(frame);
	}, MAX_BYTES);

	function onData(chunk: Buffer): void {
		try {
			decoder.push(chunk);
			if (socket.bufferedAmount > LOW_WATER_BYTES) waitForDrain();
		} catch (error) { finish(error instanceof Error ? error : new Error("Relay input failed")); }
	}
	function onEnd(): void {
		try { decoder.end(); }
		catch (error) { finish(error instanceof Error ? error : new Error("Relay input ended mid-frame")); return; }
		endDrain();
	}
	function onInputError(): void { finish(new BridgeError("STDIN_FAILED", "Relay stdin failed")); }
	function onInputClose(): void { if (!inputEnded) finish(new BridgeError("STDIN_CLOSED", "Relay stdin closed before EOF")); }
	function onOutputError(): void { finish(new BridgeError("STDOUT_FAILED", "Relay stdout failed")); }
	function onOutputClose(): void { finish(new BridgeError("STDOUT_CLOSED", "Relay stdout closed")); }
	function onAbort(): void { finish(options.signal?.reason instanceof Error ? options.signal.reason : new BridgeError("CANCELLED", "Relay interrupted")); }

	input.pause();
	input.on("error", onInputError);
	input.on("close", onInputClose);
	input.on("end", onEnd);
	output.on("error", onOutputError);
	output.on("close", onOutputClose);
	options.signal?.addEventListener("abort", onAbort, { once: true });
	socket.addEventListener("open", () => {
		if (finished) return;
		clearTimeout(connectTimer);
		input.on("data", onData);
		if (input.readableEnded) onEnd();
		else input.resume();
	});
	socket.addEventListener("message", event => {
		if (finished) return;
		try {
			if (typeof event.data !== "string" || Buffer.byteLength(event.data) > MAX_BYTES) throw new BridgeError("INVALID_FRAME", "Relay requires bounded text WebSocket frames");
			const value: unknown = JSON.parse(event.data);
			const parsed = WireFrameSchema.safeParse(value);
			if (!parsed.success) throw new BridgeError("INVALID_FRAME", "Relay server sent an invalid wire frame");
			const line = JSON.stringify(parsed.data) + "\n";
			if (output.writableLength + Buffer.byteLength(line) > MAX_BYTES + 1) throw new BridgeError("BACKPRESSURE", "Relay stdout queue exceeded its bounded size");
			pendingWrites++;
			output.write(line, error => {
				pendingWrites--;
				if (error) onOutputError();
				else if (inputEnded) drain();
				if (finished && pendingWrites === 0) setImmediate(() => {
					output.off("error", onOutputError);
					output.off("close", onOutputClose);
				});
			});
		} catch (error) {
			finish(error instanceof BridgeError ? error : new BridgeError("INVALID_FRAME", "Relay server sent malformed JSON"));
		}
	});
	socket.addEventListener("error", () => finish(new BridgeError("CONNECTION_LOST", "Relay WebSocket failed; no requests were replayed")));
	socket.addEventListener("close", event => {
		clearTimeout(closeTimer);
		if (finished) { settle(); return; }
		if (event.code !== 1000) finish(new BridgeError("CONNECTION_LOST", `Relay WebSocket closed (${event.code}); execution outcome may be unknown`));
		else if (pendingWrites === 0) finish();
		else endDrain();
	});
	if (options.signal?.aborted) onAbort();
	return done.promise;
}
