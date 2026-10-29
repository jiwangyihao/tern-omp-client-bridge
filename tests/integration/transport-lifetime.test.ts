// SPDX-License-Identifier: MPL-2.0
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { startBroker } from "../../src/broker.ts";
import { startClientService, type ClientService } from "../../src/client.ts";
import { openClientTransport, type ClientConnection, type ClientTransport } from "../../src/client-transport.ts";
import { loadClientIdentity, signIdentity, type ClientIdentity } from "../../src/config.ts";
import { runRelay } from "../../src/relay.ts";
import { PROTOCOL_VERSION } from "../../src/protocol.ts";
import { JsonLineDecoder, RpcPeer } from "../../src/wire.ts";

const Nonce = z.object({ nonce: z.string() });

interface PairedTransport { readonly disconnected: Error | undefined; close(): Promise<void> }
async function paired(connection: ClientConnection, identity: ClientIdentity): Promise<PairedTransport> {
	const ready = Promise.withResolvers<void>();
	let transport: ClientTransport;
	let disconnected: Error | undefined;
	const peer = new RpcPeer(frame => transport.send(frame), undefined, (name, body) => {
		if (name === "challenge") void peer.request("register", { device: identity.device, publicKey: identity.publicKey, signature: signIdentity(Nonce.parse(body).nonce, identity) }, { timeoutMs: 5000 }).then(() => ready.resolve(), ready.reject);
	});
	transport = openClientTransport(connection, frame => peer.receive(frame), error => { disconnected = error; peer.close(error); ready.reject(error); });
	try { await ready.promise; return { get disconnected() { return disconnected; }, close: async () => { peer.close(); await transport.close(); } }; }
	catch (error) { peer.close(); await transport.close(); throw error; }
}

test("orphan relay releases its identity without duplicate takeover and a real Client reconnects automatically", async () => {
	const root = await mkdtemp(join(tmpdir(), "bridge-transport-lifetime-"));
	const server = await startBroker({ stateDir: join(root, "server") });
	const connection: ClientConnection = { kind: "loopback", endpoint: server.endpoint };
	const identity = await loadClientIdentity(join(root, "identity"), { name: "Orphan owner" });
	const healthyIdentity = await loadClientIdentity(join(root, "healthy-identity"), { name: "Healthy owner" });
	const input = new PassThrough();
	const output = new PassThrough();
	const abort = new AbortController();
	const ready = Promise.withResolvers<void>();
	let abandoned = false;
	let relaySettled = false;
	const peer = new RpcPeer(frame => { input.write(JSON.stringify(frame) + "\n"); }, undefined, (name, body) => {
		if (name === "challenge") void peer.request("register", { device: identity.device, publicKey: identity.publicKey, signature: signIdentity(Nonce.parse(body).nonce, identity) }).then(() => ready.resolve(), ready.reject);
	});
	const decoder = new JsonLineDecoder(frame => { if (!abandoned) peer.receive(frame); });
	output.on("data", chunk => decoder.push(chunk));
	const relay = runRelay({ stateDir: join(root, "server"), input, output, signal: abort.signal }).then(() => { relaySettled = true; }, () => { relaySettled = true; });
	let replacement: ClientService | undefined;
	let healthy: PairedTransport | undefined;
	try {
		await ready.promise;
		await expect(paired(connection, identity)).rejects.toMatchObject({ code: "DUPLICATE_CLIENT" });
		healthy = await paired(connection, healthyIdentity);
		// Keep both remote streams open, just as a surviving sshd channel can do.
		// A WebSocket ping/pong still reaches the real relay; no Client bytes return.
		abandoned = true;
		replacement = await startClientService({ identity, serverName: "Transport fixture", stateDir: join(root, "replacement"), connection: { kind: "loopback", endpoint: server.endpoint } });
		await expect(replacement.waitForConnection(AbortSignal.timeout(500))).rejects.toThrow();
		expect(relaySettled).toBe(false);
		await replacement.waitForConnection(AbortSignal.timeout(55_000));
		expect(relaySettled).toBe(true);
		expect(healthy.disconnected).toBeUndefined();
		await expect(paired(connection, identity)).rejects.toMatchObject({ code: "DUPLICATE_CLIENT" });
		await expect(paired(connection, healthyIdentity)).rejects.toMatchObject({ code: "DUPLICATE_CLIENT" });
	} finally {
		abort.abort(); await relay; peer.close(); input.destroy(); output.destroy();
		await replacement?.close(); await healthy?.close(); await server.close();
		await rm(root, { recursive: true, force: true });
	}
}, 65_000);

// The executable fixture below is a POSIX SSH-process stand-in, not native Windows
// SSH coverage. Keep Windows recovery/healthy-loopback coverage in the test above.
test.skipIf(process.platform === "win32")("POSIX SSH-process transport keeps a healthy real relay registered", async () => {
	const root = await mkdtemp(join(tmpdir(), "bridge-ssh-lifetime-"));
	const server = await startBroker({ stateDir: join(root, "server") });
	const identity = await loadClientIdentity(join(root, "identity"), { name: "Healthy SSH owner" });
	let healthy: PairedTransport | undefined;
	try {
		const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
		const sshExecutable = join(root, "ssh");
		// Only the SSH process boundary is substituted; CLI, relay, broker and
		// signed registration remain real. No shell:true, sshd or remote host.
		await writeFile(sshExecutable, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fileURLToPath(new URL("../../src/cli.ts", import.meta.url)))} relay --state-dir ${shellQuote(join(root, "server"))}\n`, { mode: 0o700 });
		healthy = await paired({ kind: "ssh", host: "transport-fixture", remoteCommand: "real-relay", sshExecutable }, identity);
		// Real time is intentional: the broker and child CLI run independent clocks;
		// this must outlive the 15s probe + 30s response deadline, not fake one side.
		await Bun.sleep(46_000);
		expect(healthy.disconnected).toBeUndefined();
		await expect(paired({ kind: "loopback", endpoint: server.endpoint }, identity)).rejects.toMatchObject({ code: "DUPLICATE_CLIENT" });
	} finally { await healthy?.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
}, 60_000);

test("relay EOF with a permanently blocked stdout write has a bounded failure", async () => {
	const root = await mkdtemp(join(tmpdir(), "bridge-relay-drain-"));
	const server = await startBroker({ stateDir: join(root, "server") });
	const input = new PassThrough();
	const wrote = Promise.withResolvers<void>();
	const output = new Writable({ write(_chunk, _encoding, _callback) { wrote.resolve(); } });
	const abort = new AbortController();
	const relay = runRelay({ stateDir: join(root, "server"), input, output, signal: abort.signal });
	void relay.catch(() => {});
	try {
		await wrote.promise;
		input.end();
		await expect(relay).rejects.toMatchObject({ code: "DRAIN_TIMEOUT" });
	} finally {
		abort.abort(); await relay.catch(() => {}); input.destroy(); output.destroy();
		await server.close(); await rm(root, { recursive: true, force: true });
	}
}, 10_000);

test("Client transport expires a half-open broker despite unrelated traffic and never replays a pending operation", async () => {
	const received: unknown[] = [];
	const events: string[] = [];
	let disconnects = 0;
	const server = Bun.serve<{ activity?: NodeJS.Timeout }>({ hostname: "127.0.0.1", port: 0, fetch(request, server) {
		if (server.upgrade(request, { data: {} })) return;
		return new Response("not found", { status: 404 });
	}, websocket: {
		idleTimeout: 120,
		open(socket) {
			socket.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: "event", name: "transport.ping", body: { nonce: crypto.randomUUID() } }));
			// Deliberately exercise real Bun WebSocket liveness: JS fake timers cannot
			// advance the native socket's ping/idle clock together with the watchdog.
			socket.data.activity = setInterval(() => socket.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: "event", name: "activity" })), 1000);
		},
		message(_socket, message) { received.push(JSON.parse(String(message))); },
		close(socket) { clearInterval(socket.data.activity); },
	} });
	let transport: ClientTransport;
	const peer = new RpcPeer(frame => transport.send(frame), undefined, name => events.push(name));
	transport = openClientTransport({ kind: "loopback", endpoint: { url: `http://127.0.0.1:${server.port}`, token: "fixture" } }, value => peer.receive(value), error => { disconnects++; peer.close(error); });
	try {
		const pending = peer.request("non-replayable-operation", { value: 1 }, { timeoutMs: 75_000 });
		await expect(pending).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
		expect(disconnects).toBe(1);
		expect(events).toContain("activity");
		expect(events).not.toContain("transport.ping");
		expect(received.filter(value => z.object({ kind: z.literal("request") }).safeParse(value).success)).toHaveLength(1);
		await expect(transport.send({ v: PROTOCOL_VERSION, kind: "request", id: "must-not-send", seq: 2, method: "non-replayable-operation" })).rejects.toMatchObject({ code: "CONNECTION_LOST" });
	} finally { peer.close(); await transport.close(); await server.stop(true); }
}, 70_000);

test("an unsolicited transport pong cannot renew identity ownership", async () => {
	const root = await mkdtemp(join(tmpdir(), "bridge-pong-ownership-"));
	const server = await startBroker({ stateDir: join(root, "server") });
	const identity = await loadClientIdentity(join(root, "identity"), { name: "Nonce owner" });
	const ready = Promise.withResolvers<void>();
	const closed = Promise.withResolvers<number>();
	const url = new URL("/v1/connect", server.endpoint.url); url.protocol = "ws:";
	const socket = new WebSocket(url, { headers: { authorization: `Bearer ${server.endpoint.token}` } });
	const peer = new RpcPeer(frame => { socket.send(JSON.stringify(frame)); }, undefined, (name, body) => {
		if (name === "challenge") void peer.request("register", { device: identity.device, publicKey: identity.publicKey, signature: signIdentity(Nonce.parse(body).nonce, identity) }).then(() => ready.resolve(), ready.reject);
	});
	socket.addEventListener("message", event => peer.receive(JSON.parse(String(event.data))));
	socket.addEventListener("error", () => ready.reject(new Error("Nonce fixture connection failed")));
	socket.addEventListener("close", event => { peer.close(); closed.resolve(event.code); });
	try {
		await ready.promise;
		peer.notify("transport.pong", { nonce: crypto.randomUUID() });
		expect(await closed.promise).toBe(1008);
		const replacement = await paired({ kind: "loopback", endpoint: server.endpoint }, identity);
		await replacement.close();
	} finally { peer.close(); socket.terminate(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

test("a legacy protocol client is rejected before registration while the current peer can pair", async () => {
	const root = await mkdtemp(join(tmpdir(), "bridge-protocol-version-"));
	const server = await startBroker({ stateDir: join(root, "server") });
	const identity = await loadClientIdentity(join(root, "identity"));
	const closed = Promise.withResolvers<number>();
	const url = new URL("/v1/connect", server.endpoint.url); url.protocol = "ws:";
	const socket = new WebSocket(url, { headers: { authorization: `Bearer ${server.endpoint.token}` } });
	socket.addEventListener("message", event => {
		try {
			const frame = z.object({ v: z.literal(PROTOCOL_VERSION), kind: z.literal("event"), name: z.string(), body: z.unknown() }).parse(JSON.parse(String(event.data)));
			if (frame.name === "challenge") socket.send(JSON.stringify({ v: 1, kind: "request", id: "legacy-registration", seq: 1, method: "register", body: { device: identity.device, publicKey: identity.publicKey, signature: signIdentity(Nonce.parse(frame.body).nonce, identity) } }));
		} catch (error) { closed.reject(error); }
	});
	socket.addEventListener("error", () => closed.reject(new Error("Protocol fixture connection failed")));
	socket.addEventListener("close", event => closed.resolve(event.code));
	try {
		expect(await closed.promise).toBe(1008);
		const current = await paired({ kind: "loopback", endpoint: server.endpoint }, identity);
		await current.close();
	} finally { socket.terminate(); await server.close(); await rm(root, { recursive: true, force: true }); }
});
