// SPDX-License-Identifier: MPL-2.0
import { spawn } from "node:child_process";
import type { Endpoint } from "./config.ts";
import { BridgeError, PROTOCOL_VERSION } from "./protocol.ts";
import { JsonLineDecoder, TRANSPORT_SILENCE_TIMEOUT_MS, TransportPingSchema, type WireFrame } from "./wire.ts";

export type ClientConnection =
	| { kind: "ssh"; host: string; remoteCommand: string; sshExecutable?: string }
	| { kind: "loopback"; endpoint: Endpoint };
export interface ClientTransport {
	send(frame: WireFrame): Promise<void>;
	close(): Promise<void>;
}
const MAX_BYTES = 64 * 1024 * 1024;

/** A single outbound connection. Reconnection never belongs to this operation stream. */
export function openClientTransport(connection: ClientConnection, receive: (frame: unknown) => void, disconnected: (error: Error) => void): ClientTransport {
	let closed = false;
	let queuedBytes = 0;
	let writes = Promise.resolve();
	let stop: () => Promise<void>;
	let write: (line: string) => Promise<void>;
	let closing: Promise<void> | undefined;
	let heartbeatTimer: NodeJS.Timeout | undefined;
	const armHeartbeat = () => {
		clearTimeout(heartbeatTimer);
		heartbeatTimer = setTimeout(() => fail(new BridgeError("CONNECTION_LOST", "The broker stopped proving end-to-end transport liveness; operation outcomes may be unknown, nothing was replayed")), TRANSPORT_SILENCE_TIMEOUT_MS);
	};
	const receiveFrame = (value: unknown) => {
		if (closed) return;
		const ping = TransportPingSchema.safeParse(value);
		if (!ping.success) { receive(value); return; }
		armHeartbeat();
		void send({ v: PROTOCOL_VERSION, kind: "event", name: "transport.pong", body: ping.data.body }).catch(fail);
	};
	const fail = (error: unknown) => {
		if (closed) return;
		closed = true;
		clearTimeout(heartbeatTimer);
		try { disconnected(error instanceof Error ? error : new Error(String(error))); }
		finally { void (closing ??= stop()).catch(() => {}); }
	};
	if (connection.kind === "loopback") {
		const url = new URL(connection.endpoint.url);
		if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password) throw new BridgeError("INVALID_ENDPOINT", "Explicit integration connections must use loopback HTTP");
		url.pathname = "/v1/connect"; url.search = ""; url.hash = ""; url.protocol = "ws:";
		const socket = new WebSocket(url, { headers: { authorization: `Bearer ${connection.endpoint.token}` } });
		const opened = Promise.withResolvers<void>();
		// Registration may fail before the first write consumes this promise.
		void opened.promise.catch(() => {});
		socket.addEventListener("open", () => opened.resolve());
		socket.addEventListener("message", event => {
			try {
				if (typeof event.data !== "string" || Buffer.byteLength(event.data) > MAX_BYTES) throw new BridgeError("INVALID_FRAME", "Expected a bounded text protocol frame");
				receiveFrame(JSON.parse(event.data));
			} catch (error) { fail(error); }
		});
		socket.addEventListener("error", () => fail(new BridgeError("CONNECTION_LOST", "The outbound broker connection failed")));
		socket.addEventListener("close", () => fail(new BridgeError("CONNECTION_LOST", "The outbound broker connection closed")));
		write = async line => {
			await opened.promise;
			if (closed || socket.readyState !== WebSocket.OPEN) throw new BridgeError("CONNECTION_LOST", "The broker connection is closed");
			if (socket.bufferedAmount + Buffer.byteLength(line) > MAX_BYTES) throw new BridgeError("BACKPRESSURE", "Broker connection exceeded its bounded send buffer");
			socket.send(line);
		};
		stop = async () => {
			opened.reject(new BridgeError("CONNECTION_LOST", "The broker connection closed"));
			// Failed handshakes can already be CLOSED without a later close event.
			// Termination also aborts CONNECTING sockets; do not await a graceful
			// handshake from a peer that never opened or has stopped responding.
			if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
		};
	} else {
		if (!connection.host || connection.host.startsWith("-") || /[\s\x00-\x1f]/.test(connection.host) || !connection.remoteCommand || connection.remoteCommand.includes("\0")) throw new BridgeError("INVALID_SSH", "Provide an SSH alias and a remote relay command");
		const child = spawn(connection.sshExecutable ?? "ssh", ["-T", "-o", "BatchMode=yes", "-o", "ForwardAgent=no", "-o", "StrictHostKeyChecking=yes", connection.host, connection.remoteCommand], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
		const exited = Promise.withResolvers<void>();
		let stderrBytes = 0;
		const decoder = new JsonLineDecoder(receiveFrame, MAX_BYTES);
		child.stdout.on("data", (chunk: Buffer) => { try { decoder.push(chunk); } catch (error) { fail(error); } });
		// Drain without exposing remote banners, usernames, commands or credentials.
		child.stderr.on("data", (chunk: Buffer) => { stderrBytes = Math.min(MAX_BYTES, stderrBytes + chunk.byteLength); });
		child.on("error", () => fail(new BridgeError("SSH_UNAVAILABLE", "The SSH relay could not be started")));
		child.stdin.on("error", () => fail(new BridgeError("CONNECTION_LOST", "The SSH relay input closed")));
		child.stdout.on("error", () => fail(new BridgeError("CONNECTION_LOST", "The SSH relay output failed")));
		child.stderr.on("error", () => fail(new BridgeError("CONNECTION_LOST", "The SSH relay diagnostics stream failed")));
		child.on("close", (code, signal) => {
			exited.resolve();
			try { decoder.end(); } catch (error) { fail(error); return; }
			fail(new BridgeError("CONNECTION_LOST", `SSH relay closed (exit ${code ?? "none"}, signal ${signal ?? "none"}, stderr ${stderrBytes} bytes); no operations were replayed`));
		});
		write = line => {
			const done = Promise.withResolvers<void>();
			child.stdin.write(line + "\n", error => { if (error) done.reject(error); else done.resolve(); });
			return done.promise;
		};
		stop = async () => {
			child.stdin.destroy();
			// Inherited remote pipes must not keep local shutdown waiting after SSH exits.
			child.stdout.destroy(); child.stderr.destroy();
			if (child.exitCode === null && child.signalCode === null) child.kill();
			const force = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 2000);
			try { await exited.promise; } finally { clearTimeout(force); }
		};
	}
	function send(frame: WireFrame): Promise<void> {
		if (closed) return Promise.reject(new BridgeError("CONNECTION_LOST", "The outbound transport is closed"));
		const line = JSON.stringify(frame);
		const bytes = Buffer.byteLength(line) + 1;
		if (bytes > MAX_BYTES || queuedBytes + bytes > MAX_BYTES) {
			const error = new BridgeError("BACKPRESSURE", "Outbound frames exceeded the bounded transport queue");
			fail(error); return Promise.reject(error);
		}
		queuedBytes += bytes;
		const sent = writes.then(() => { if (closed) throw new BridgeError("CONNECTION_LOST", "The outbound transport closed"); return write(line); });
		writes = sent.then(() => { queuedBytes -= bytes; }, error => { queuedBytes -= bytes; fail(error); });
		return sent;
	}
	armHeartbeat();
	return {
		send,
		close() { closed = true; clearTimeout(heartbeatTimer); return closing ??= stop(); },
	};
}
