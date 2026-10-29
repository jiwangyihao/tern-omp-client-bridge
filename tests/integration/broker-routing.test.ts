// SPDX-License-Identifier: MPL-2.0
import { expect, setSystemTime, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { startBroker } from "../../src/broker.ts";
import { BrokerClient } from "../../src/broker-client.ts";
import { startClientService, type ClientService } from "../../src/client.ts";
import { loadClientIdentity, signIdentity, type Endpoint } from "../../src/config.ts";
import { CaptureResultSchema, LocalUiStateSchema, NativePanelSnapshotSchema, PanelStateSchema, TransferStatusSchema, UiIntentReceiptSchema } from "../../src/schemas.ts";
import type { DraftChannel, DraftDestination, DraftIntent, LocalUiState } from "../../src/api.ts";
import type { ToolResult } from "../../src/protocol.ts";
import { RpcPeer, TransportHeartbeatSchema } from "../../src/wire.ts";

const Ok = z.object({ ok: z.literal(true) });
async function ui<T extends z.ZodType>(endpoint: Endpoint, route: string, schema: T, body?: unknown, signal?: AbortSignal): Promise<z.output<T>> {
	const response = await fetch(endpoint.url + route, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${endpoint.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal });
	const value: unknown = await response.json();
	if (!response.ok) throw new Error(`UI ${route}: ${JSON.stringify(value)}`);
	return schema.parse(value);
}
async function stateWhen(client: ClientService, predicate: (state: LocalUiState) => boolean): Promise<LocalUiState> {
	const signal = AbortSignal.timeout(20000);
	// Exercise the same state API consumed by Tern; each wait is an actual HTTP response.
	for (;;) {
		const state = await ui(client.endpoint, "/v1/state", LocalUiStateSchema, undefined, signal);
		if (predicate(state)) return state;
		signal.throwIfAborted();
	}
}
function text(result: ToolResult): string { return result.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n"); }

interface DraftFixture {
	channel: DraftChannel;
	destination: DraftDestination;
	update(token: string): Promise<DraftDestination>;
	intent(id?: string): Promise<DraftIntent>;
}
async function openDraft(broker: BrokerClient, sessionId = "conversation", draftToken = "draft"): Promise<DraftFixture> {
	const destinations = new Map<string, DraftDestination>();
	const intents = new Map<string, DraftIntent>();
	const waiters = new Set<() => void>();
	const channel = broker.openDraft(sessionId, draftToken, {
		onDestination(value) { if (value) destinations.set(value.draftToken, value); for (const wake of [...waiters]) wake(); },
		onIntent(value) { intents.set(value.id, value); for (const wake of [...waiters]) wake(); },
		onError() {},
	});
	async function take<T>(read: () => T | undefined): Promise<T> {
		const waiting = Promise.withResolvers<T>();
		const signal = AbortSignal.timeout(15000);
		const abort = () => waiting.reject(signal.reason);
		const wake = () => { const value = read(); if (value !== undefined) waiting.resolve(value); };
		waiters.add(wake); signal.addEventListener("abort", abort, { once: true }); wake();
		try { return await waiting.promise; } finally { waiters.delete(wake); signal.removeEventListener("abort", abort); }
	}
	const destination = await take(() => destinations.get(draftToken));
	return { channel, destination, async update(token: string) { channel.update(token); return take(() => destinations.get(token)); }, intent(id?: string) { return take(() => { const key = id ?? intents.keys().next().value; if (!key) return; const value = intents.get(key); intents.delete(key); return value; }); } };
}
const draftOwners = new WeakMap<BrokerClient, DraftFixture>();

interface PairedFixture { readonly peer: RpcPeer; close(): void }
async function paired(endpoint: Endpoint, stateDir: string): Promise<PairedFixture> {
	const identity = await loadClientIdentity(stateDir, { name: "Direct protocol fixture" });
	const ready = Promise.withResolvers<void>();
	const url = new URL("/v1/connect", endpoint.url); url.protocol = "ws:";
	const socket = new WebSocket(url, { headers: { authorization: `Bearer ${endpoint.token}` } });
	const peer = new RpcPeer(frame => { socket.send(JSON.stringify(frame)); }, undefined, (name, body) => {
		if (name === "transport.ping") { peer.notify("transport.pong", TransportHeartbeatSchema.parse(body)); return; }
		if (name === "challenge") {
			const { nonce } = z.object({ nonce: z.string() }).parse(body);
			void peer.request("register", { device: identity.device, publicKey: identity.publicKey, signature: signIdentity(nonce, identity) }, { timeoutMs: 15000 }).then(() => ready.resolve(), ready.reject);
		}
	});
	socket.addEventListener("message", event => { try { peer.receive(JSON.parse(String(event.data))); } catch (error) { ready.reject(error); } });
	socket.addEventListener("error", () => ready.reject(new Error("Fixture paired channel failed")));
	socket.addEventListener("close", () => peer.close());
	await ready.promise;
	return { peer, close() { peer.close(); socket.close(); } };
}

async function fixture(count: number) {
	const root = await mkdtemp(join(tmpdir(), "bridge-routing-"));
	const server = await startBroker({ stateDir: join(root, "server") });
	const broker = new BrokerClient({ endpoint: server.endpoint });
	const clients: ClientService[] = [];
	try {
		for (let index = 0; index < count; index++) {
			const stateDir = join(root, `client-${index}`);
			const cwd = join(root, `files-${index}`); await mkdir(cwd);
			await mkdir(join(cwd, ".omp"));
			await writeFile(join(cwd, ".omp", "config.yml"), Bun.YAML.stringify({
				tools: { approvalMode: "yolo", approval: { read: "allow", write: "allow", edit: "allow", grep: "allow", glob: "allow", bash: "allow", eval: "allow", computer: "prompt", browser: "prompt" } },
				eval: { js: true, py: true }, computer: { enabled: true }, browser: { enabled: true },
			}));
			const identity = await loadClientIdentity(stateDir, { name: `Synthetic client ${index}` });
			clients.push(await startClientService({ stateDir, cwd, identity, serverName: "Synthetic broker", connection: { kind: "loopback", endpoint: server.endpoint } }));
		}
		await Promise.all(clients.map(client => client.waitForConnection(AbortSignal.timeout(20000))));
		draftOwners.set(broker, await openDraft(broker));
		return { root, server, broker, clients, close: async () => { broker.close(); const results = await Promise.allSettled([server.close()]); results.push(...await Promise.allSettled(clients.map(client => client.close()))); await rm(root, { recursive: true, force: true }); const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []); if (errors.length) throw new AggregateError(errors, "Fixture cleanup failed"); } };
	} catch (error) { broker.close(); await Promise.allSettled([server.close(), ...clients.map(client => client.close())]); await rm(root, { recursive: true, force: true }); throw error; }
}
async function resolveView(client: ClientService, broker: BrokerClient, viewId: string, target = draftOwners.get(broker)!) {
	const receipt = await ui(client.endpoint, "/v1/intents", UiIntentReceiptSchema, { kind: "resolve", viewId, destinationId: target.destination.id });
	const intent = await target.intent(receipt.id);
	await broker.claimIntent(intent.id, intent.sessionId, intent.draftToken, intent.destinationId); await broker.finishIntent(intent.id);
	const state = await stateWhen(client, state => state.views[viewId]?.resolveIntentId === receipt.id);
	return state.views[viewId]!;
}
async function bind(client: ClientService, broker: BrokerClient, viewId: string, clientId: string | null, expectedRevision: number) {
	const view = (await ui(client.endpoint, "/v1/state", LocalUiStateSchema)).views[viewId]!;
	const receipt = await ui(client.endpoint, "/v1/intents", UiIntentReceiptSchema, { kind: "bind", viewId, sessionId: view.sessionId, draftToken: view.draftToken, clientId, expectedRevision });
	const intent = await draftOwners.get(broker)!.intent(receipt.id);
	const result = await broker.claimIntent(intent.id, intent.sessionId, intent.draftToken, intent.destinationId); await broker.finishIntent(intent.id);
	return result.state;
}

test("manual binding enables native execution without grants and unbinding rejects new invocations", async () => {
	const f = await fixture(1);
	const client = f.clients[0]!;
	try {
		await resolveView(client, f.broker, "view");
		const state = await ui(client.endpoint, "/v1/state", LocalUiStateSchema);
		expect(state.device).not.toHaveProperty("capabilities");
		const params = { language: "js", code: 'print("BOUND_NATIVE_EXECUTION");' };
		await expect(f.broker.invoke("conversation", "execution-root", "eval", params)).rejects.toMatchObject({ code: "UNBOUND" });
		await bind(client, f.broker, "view", state.device.id, 0);
		const result = await f.broker.invoke("conversation", "execution-root", "eval", params);
		expect(result.isError).not.toBe(true);
		expect(text(result)).toContain("BOUND_NATIVE_EXECUTION");
		expect(result.details).toMatchObject({ clientBridge: { target: { device: { id: state.device.id }, bindingRevision: 1 } } });
		await bind(client, f.broker, "view", null, 1);
		await expect(f.broker.invoke("conversation", "execution-root", "eval", params)).rejects.toMatchObject({ code: "UNBOUND" });
	} finally { await f.close(); }
}, 60000);

test("three real helpers converge on one binding while active native Eval stays on its original client", async () => {
	const f = await fixture(3);
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<Response>();
	const gate = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { entered.resolve(); return release.promise; } });
	try {
		const [a, b, c] = f.clients;
		const views = await Promise.all(f.clients.map((client, index) => resolveView(client, f.broker, `view-${index}`)));
		for (const view of views) expect(view.state.binding.clientId).toBeNull();
		const identities = await Promise.all(f.clients.map(client => ui(client.endpoint, "/v1/state", LocalUiStateSchema)));
		const stale = await ui(b!.endpoint, "/v1/intents", UiIntentReceiptSchema, { kind: "bind", viewId: "view-1", sessionId: "conversation", draftToken: views[1]!.draftToken, clientId: identities[2]!.device.id, expectedRevision: 0 });
		await bind(a!, f.broker, "view-0", identities[1]!.device.id, 0);
		await expect(f.broker.claimIntent(stale.id, "conversation", "draft", views[1]!.destinationId)).rejects.toMatchObject({ code: "STALE_BINDING" });
		for (const [index, client] of f.clients.entries()) {
			const state = await stateWhen(client, state => state.views[`view-${index}`]?.state.binding.revision === 1);
			expect(state.views[`view-${index}`]!.state.binding.clientId).toBe(identities[1]!.device.id);
			expect(state.views[`view-${index}`]!.state.binding.change?.actor.id).toBe(identities[0]!.device.id);
		}
		expect((await f.broker.state("other-conversation")).binding.clientId).toBeNull();
		const updates: ToolResult[] = [];
		const active = f.broker.invoke("conversation", "execution-root", "eval", { language: "js", code: `globalThis.bridgeOwner = "PINNED_B"; await fetch("http://127.0.0.1:${gate.port}/gate"); print(globalThis.bridgeOwner);`, timeout: 30 }, { onUpdate: result => updates.push(result) });
		await Promise.race([entered.promise, active.then(result => { throw new Error(`Native Eval finished before reaching its gate: ${text(result)}`); })]);
		await bind(a!, f.broker, "view-0", identities[2]!.device.id, 1);
		release.resolve(new Response("released"));
		const completed = await active;
		expect(text(completed)).toContain("PINNED_B");
		const originalTarget = { device: { id: identities[1]!.device.id }, bindingRevision: 1, sessionId: "conversation", contextId: "execution-root" };
		expect(completed.details).toMatchObject({ clientBridge: { target: originalTarget } });
		for (const update of updates) expect(update.details).toMatchObject({ clientBridge: { target: originalTarget } });
		const next = await f.broker.invoke("conversation", "execution-root", "eval", { language: "js", code: 'print(typeof globalThis.bridgeOwner === "undefined" ? "C_ISOLATED" : "WRONG_OWNER");' });
		expect(text(next)).toContain("C_ISOLATED");
		expect(next.details).toMatchObject({ clientBridge: { target: { device: { id: identities[2]!.device.id }, bindingRevision: 2 } } });
		await bind(a!, f.broker, "view-0", identities[1]!.device.id, 2);
		expect(text(await f.broker.invoke("conversation", "execution-root", "eval", { language: "js", code: "print(globalThis.bridgeOwner);" }))).toContain("PINNED_B");
		await f.broker.closeContext("conversation", "execution-root");
	} finally { release.resolve(new Response("released")); await gate.stop(true); await f.close(); }
}, 120000);

test("unbound human uploads preserve bytes and cancellation cannot claim a native handoff was undone", async () => {
	const f = await fixture(1);
	const client = f.clients[0]!;
	try {
		const view = await resolveView(client, f.broker, "view");
		const source = join(f.root, "图片 with spaces.bin");
		const bytes = Buffer.alloc(1048593, 0x35); await writeFile(source, bytes);
		const start = async () => {
			const captured = await ui(client.endpoint, "/v1/captures", CaptureResultSchema, { kind: "files", paths: [source] });
			const transfer = await ui(client.endpoint, "/v1/transfers", TransferStatusSchema, { viewId: "view", captureId: captured.id, expectedSessionId: view.sessionId, expectedDraftToken: view.draftToken, expectedResolveIntentId: view.resolveIntentId });
			const state = await stateWhen(client, state => state.transfers.some(item => item.id === transfer.id && (item.phase === "ready" || item.phase === "failed")));
			const ready = state.transfers.find(item => item.id === transfer.id)!;
			if (ready.phase !== "ready") throw new Error(ready.error ?? "No attachment intent was prepared");
			const intent = await draftOwners.get(f.broker)!.intent();
			return { transfer: ready, intentId: intent.id };
		};
		const first = await start();
		expect((await f.broker.state("conversation")).binding.clientId).toBeNull();
		const destination = join(f.root, "server", "imports", first.transfer.id);
		const filename = (await readdir(destination)).find(name => name !== "README");
		expect(await readFile(join(destination, filename!))).toEqual(bytes);
		await ui(client.endpoint, "/v1/transfers/cancel", Ok, { id: first.transfer.id });
		await expect(f.broker.claimIntent(first.intentId, "conversation", "draft", view.destinationId)).rejects.toMatchObject({ code: "INTENT_CONSUMED" });
		const second = await start();
		const claimed = await f.broker.claimIntent(second.intentId, "conversation", "draft", view.destinationId);
		expect(await readFile(claimed.files![0]!.path)).toEqual(bytes);
		await expect(ui(client.endpoint, "/v1/transfers/cancel", Ok, { id: second.transfer.id })).rejects.toThrow("CANCEL_TOO_LATE");
		await f.broker.finishIntent(second.intentId);
		await stateWhen(client, state => state.transfers.some(item => item.id === second.transfer.id && item.phase === "attached"));
		expect(await readFile(source)).toEqual(bytes);
	} finally { await f.close(); }
}, 120000);

test("unbound image transfer preserves native image format and bytes through the real broker", async () => {
	const f = await fixture(1);
	const client = f.clients[0]!;
	try {
		const view = await resolveView(client, f.broker, "image-view");
		const path = join(f.root, "synthetic image.png");
		const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
		await writeFile(path, bytes);
		const capture = await ui(client.endpoint, "/v1/captures", CaptureResultSchema, { kind: "files", paths: [path] });
		const started = await ui(client.endpoint, "/v1/transfers", TransferStatusSchema, { viewId: "image-view", captureId: capture.id, expectedSessionId: view.sessionId, expectedDraftToken: view.draftToken, expectedResolveIntentId: view.resolveIntentId });
		const state = await stateWhen(client, state => state.transfers.some(item => item.id === started.id && (item.phase === "ready" || item.phase === "failed")));
		const ready = state.transfers.find(item => item.id === started.id)!;
		expect(ready.phase).toBe("ready");
		const { id: intentId } = await draftOwners.get(f.broker)!.intent();
		const claimed = await f.broker.claimIntent(intentId, view.sessionId, view.draftToken, view.destinationId);
		expect(claimed.state.binding.clientId).toBeNull();
		expect(claimed.files).toHaveLength(1);
		const file = claimed.files![0]!;
		expect(file.name).toBe("synthetic image.png");
		expect(Bun.file(file.path).type).toBe("image/png");
		expect(await readFile(file.path)).toEqual(bytes);
		await f.broker.finishIntent(intentId);
		await stateWhen(client, state => state.transfers.some(item => item.id === started.id && item.phase === "attached"));
		expect(await readFile(path)).toEqual(bytes);
	} finally { await f.close(); }
}, 60000);

test("directed intents require the exact live channel and draft, never a sibling with matching session", async () => {
	const f = await fixture(2);
	try {
		const original = draftOwners.get(f.broker)!;
		const sibling = await openDraft(f.broker);
		const client = f.clients[0]!;
		const receipt = await ui(client.endpoint, "/v1/intents", UiIntentReceiptSchema, { kind: "resolve", viewId: "owned-view", destinationId: original.destination.id });
		const intent = await original.intent(receipt.id);
		expect(intent).toMatchObject({ id: receipt.id, destinationId: original.destination.id, sessionId: "conversation", draftToken: "draft" });
		for (const [session, token, destination] of [["other-session", "draft", original.destination.id], ["conversation", "other-draft", original.destination.id], ["conversation", "draft", sibling.destination.id]]) {
			await expect(f.broker.claimIntent(receipt.id, session!, token!, destination!)).rejects.toMatchObject({ code: "DESTINATION_CHANGED" });
		}
		await f.broker.claimIntent(receipt.id, "conversation", "draft", original.destination.id);
		await f.broker.finishIntent(receipt.id);
		await expect(f.broker.claimIntent(receipt.id, "conversation", "draft", original.destination.id)).rejects.toMatchObject({ code: "INTENT_CONSUMED" });
		await expect(f.broker.finishIntent(receipt.id)).rejects.toMatchObject({ code: "INTENT_CONSUMED" });
		await stateWhen(client, state => !!state.views["owned-view"]);
		await expect(ui(f.clients[1]!.endpoint, "/v1/intents", UiIntentReceiptSchema, { kind: "paste", viewId: "owned-view", sessionId: "conversation", draftToken: "draft", text: "foreign" })).rejects.toThrow("DESTINATION_CHANGED");
		const text = "first line\n第二行\n/tmp/not-an-upload";
		const paste = await ui(client.endpoint, "/v1/intents", UiIntentReceiptSchema, { kind: "paste", viewId: "owned-view", sessionId: "conversation", draftToken: "draft", text });
		await original.intent(paste.id);
		expect(await f.broker.claimIntent(paste.id, "conversation", "draft", original.destination.id)).toMatchObject({ kind: "paste", text });
		await f.broker.finishIntent(paste.id);
		const pending = await ui(client.endpoint, "/v1/intents", UiIntentReceiptSchema, { kind: "bind", viewId: "owned-view", sessionId: "conversation", draftToken: "draft", clientId: null, expectedRevision: 0 });
		const updated = await original.update("submitted-draft");
		expect(updated.id).toBe(original.destination.id);
		await stateWhen(client, state => !state.views["owned-view"]);
		await expect(f.broker.claimIntent(pending.id, "conversation", "draft", updated.id)).rejects.toMatchObject({ code: "INTENT_CONSUMED" });
		await expect(ui(client.endpoint, "/v1/intents", UiIntentReceiptSchema, { kind: "paste", viewId: "owned-view", sessionId: "conversation", draftToken: "draft", text: "stale" })).rejects.toThrow("DESTINATION_CHANGED");
		const fresh = await resolveView(client, f.broker, "owned-view");
		expect(fresh.draftToken).toBe("submitted-draft");
		await expect(ui(client.endpoint, "/v1/intents", UiIntentReceiptSchema, { kind: "bind", viewId: "owned-view", sessionId: "conversation", draftToken: "draft", clientId: null, expectedRevision: 0 })).rejects.toThrow("DESTINATION_CHANGED");
		original.channel.close();
		await stateWhen(client, state => !state.views["owned-view"]);
		await expect(ui(client.endpoint, "/v1/intents", UiIntentReceiptSchema, { kind: "resolve", viewId: "owned-view", destinationId: original.destination.id })).rejects.toThrow("DESTINATION_CHANGED");
		const replacement = await openDraft(f.broker, "conversation", "submitted-draft");
		expect(replacement.destination.id).not.toBe(original.destination.id);
		expect((await resolveView(client, f.broker, "owned-view", replacement)).destinationId).toBe(replacement.destination.id);
	} finally { await f.close(); }
}, 60000);

test("broker rejects upload admission and every continuation after native draft revocation", async () => {
	const f = await fixture(0);
	const writer = await paired(f.server.endpoint, join(f.root, "direct-client"));
	const sibling = await paired(f.server.endpoint, join(f.root, "other-direct-client"));
	try {
		const draft = draftOwners.get(f.broker)!;
		const receipt = UiIntentReceiptSchema.parse(await writer.peer.request("ui.intent", { kind: "resolve", viewId: "direct-view", destinationId: draft.destination.id }));
		await draft.intent(receipt.id);
		await f.broker.claimIntent(receipt.id, "conversation", "draft", draft.destination.id);
		await f.broker.finishIntent(receipt.id);
		const input = { viewId: "direct-view", sessionId: "conversation", draftToken: "draft", files: [{ name: "partial.txt", size: 2 }] };
		const upload = z.object({ id: z.string() }).parse(await writer.peer.request("upload.begin", input));
		await expect(sibling.peer.request("upload.cancel", { id: upload.id })).rejects.toMatchObject({ code: "UPLOAD_UNAVAILABLE" });
		await writer.peer.request("upload.chunk", { id: upload.id, index: 0, offset: 0, data: Buffer.from("a").toString("base64") });
		await draft.update("new-draft");
		await expect(writer.peer.request("upload.begin", input)).rejects.toMatchObject({ code: "DESTINATION_CHANGED" });
		await expect(writer.peer.request("upload.chunk", { id: upload.id, index: 0, offset: 1, data: Buffer.from("b").toString("base64") })).rejects.toMatchObject({ code: "DESTINATION_CHANGED" });
		await expect(writer.peer.request("upload.finish", { id: upload.id, sha256: ["0".repeat(64)] })).rejects.toMatchObject({ code: "DESTINATION_CHANGED" });
		await expect(writer.peer.request("ui.intent", { kind: "attach", viewId: "direct-view", sessionId: "conversation", draftToken: "draft", transferId: upload.id })).rejects.toMatchObject({ code: "DESTINATION_CHANGED" });
	} finally { writer.close(); sibling.close(); await f.close(); }
}, 30000);

test("panel records are authenticated writer-owned, display-only, bounded and permanently closed per instance", async () => {
	const f = await fixture(2);
	const writer = await paired(f.server.endpoint, join(f.root, "panel-direct-client"));
	try {
		const [a, b] = f.clients;
		const draft = draftOwners.get(f.broker)!;
		const clientId = (await ui(a!.endpoint, "/v1/state", LocalUiStateSchema)).device.id;
		const snapshot = { owner: "window-a", panelId: "panel-a", source: "Synthetic client", target: "Synthetic OMP", agent: "Unbound", connected: true, devices: [], transfers: [], approvals: 0 };
		const publish = { owner: snapshot.owner, panelId: snapshot.panelId, destinationId: draft.destination.id, snapshot };
		const route = `/v1/panels?clientId=${encodeURIComponent(clientId)}&owner=${snapshot.owner}&panelId=${snapshot.panelId}`;
		const PanelRead = z.object({ closed: z.boolean(), snapshot: NativePanelSnapshotSchema.optional() });
		expect((await fetch(f.server.endpoint.url + route)).status).toBe(401);
		expect((await fetch(f.server.endpoint.url + route, { headers: { authorization: `Bearer ${f.server.endpoint.token}`, origin: "https://example.invalid" } })).status).toBe(401);
		await expect(writer.peer.request("panel.open", { ...publish, clientId })).rejects.toThrow();
		for (const invalid of [{ ...publish, destinationId: "missing" }, { ...publish, owner: "bad/owner" }, { ...publish, snapshot: { ...snapshot, token: "private-token" } }, { ...publish, snapshot: { ...snapshot, error: "raw private /path and bearer" } }, { ...publish, snapshot: { ...snapshot, target: "x".repeat(65537) } }, { ...publish, snapshot: { ...snapshot, devices: Array.from({ length: 33 }, () => ({ name: "device", platform: "linux", online: true, bound: false })) } }]) {
			await expect(ui(a!.endpoint, "/v1/panels/open", PanelStateSchema, invalid)).rejects.toThrow();
		}
		const wide = "界".repeat(240);
		await expect(ui(a!.endpoint, "/v1/panels/open", PanelStateSchema, { ...publish, snapshot: { ...snapshot, devices: Array.from({ length: 32 }, () => ({ name: wide, platform: wide, online: true, bound: false })), transfers: Array.from({ length: 20 }, () => ({ id: wide, name: wide, phase: "ready", bytesSent: 0, totalBytes: 0 })) } })).rejects.toThrow();
		await expect(ui(a!.endpoint, "/v1/panels/publish", PanelStateSchema, publish)).rejects.toThrow("PANEL_CLOSED");
		expect(await ui(a!.endpoint, "/v1/panels/open", PanelStateSchema, publish)).toMatchObject({ phase: "waiting", destinationId: draft.destination.id });
		const siblingClientId = (await ui(b!.endpoint, "/v1/state", LocalUiStateSchema)).device.id;
		await ui(b!.endpoint, "/v1/panels/open", PanelStateSchema, { ...publish, snapshot: { ...snapshot, source: "Other authenticated writer" } });
		expect((await ui(f.server.endpoint, route.replace(clientId, siblingClientId), PanelRead)).snapshot?.source).toBe("Other authenticated writer");
		await ui(b!.endpoint, "/v1/panels/close", Ok, { owner: snapshot.owner, panelId: snapshot.panelId });
		expect(await ui(f.server.endpoint, route, PanelRead)).toEqual({ closed: false, snapshot });
		await stateWhen(a!, state => state.panels.some(panel => panel.panelId === snapshot.panelId && panel.phase === "ready"));
		expect(await ui(a!.endpoint, "/v1/panels/publish", PanelStateSchema, publish)).toMatchObject({ phase: "ready" });
		await ui(b!.endpoint, "/v1/panels/open", PanelStateSchema, { ...publish, panelId: "disconnect-panel", snapshot: { ...snapshot, panelId: "disconnect-panel" } });
		await b!.close();
		const disconnectedRoute = route.replace(clientId, siblingClientId).replace("panel-a", "disconnect-panel");
		const disconnectedSignal = AbortSignal.timeout(5000);
		while (!(await ui(f.server.endpoint, disconnectedRoute, PanelRead, undefined, disconnectedSignal)).closed) disconnectedSignal.throwIfAborted();
		await ui(f.server.endpoint, "/v1/panels/closed", Ok, { clientId, owner: snapshot.owner, panelId: "missing-panel" });
		expect((await ui(f.server.endpoint, route, PanelRead)).closed).toBe(false);
		await ui(f.server.endpoint, "/v1/panels/closed", Ok, { clientId, owner: snapshot.owner, panelId: snapshot.panelId });
		await stateWhen(a!, state => state.panels.some(panel => panel.panelId === snapshot.panelId && panel.phase === "closed"));
		expect(await ui(f.server.endpoint, route, PanelRead)).toEqual({ closed: true });
		await expect(ui(a!.endpoint, "/v1/panels/publish", PanelStateSchema, publish)).rejects.toThrow("PANEL_CLOSED");
		await expect(ui(a!.endpoint, "/v1/panels/open", PanelStateSchema, publish)).rejects.toThrow("PANEL_CLOSED");
		const reopened = { ...publish, panelId: "panel-b", snapshot: { ...snapshot, panelId: "panel-b" } };
		await ui(a!.endpoint, "/v1/panels/open", PanelStateSchema, reopened);
		draft.channel.close();
		await stateWhen(a!, state => state.panels.some(panel => panel.panelId === "panel-b" && panel.phase === "closed"));
		expect(await ui(f.server.endpoint, route.replace("panel-a", "panel-b"), PanelRead)).toEqual({ closed: true });
	} finally { writer.close(); await f.close(); }
}, 60000);

test("native panel heartbeat expiry closes a record without cancelling an owned transfer", async () => {
	const f = await fixture(1);
	try {
		const client = f.clients[0]!;
		const view = await resolveView(client, f.broker, "panel-upload-view");
		const source = join(f.root, "panel-upload.txt"); await writeFile(source, "retained upload");
		const capture = await ui(client.endpoint, "/v1/captures", CaptureResultSchema, { kind: "files", paths: [source] });
		const transfer = await ui(client.endpoint, "/v1/transfers", TransferStatusSchema, { viewId: view.viewId, captureId: capture.id, expectedSessionId: view.sessionId, expectedDraftToken: view.draftToken, expectedResolveIntentId: view.resolveIntentId });
		await stateWhen(client, state => state.transfers.some(item => item.id === transfer.id && item.phase === "ready"));
		const intent = await draftOwners.get(f.broker)!.intent();
		const snapshot = { owner: "expiry-owner", panelId: "expiry-panel", source: "Client", target: "OMP", agent: "Unbound", connected: true, devices: [], transfers: [], approvals: 0 };
		const publishedAt = Date.now();
		await ui(client.endpoint, "/v1/panels/open", PanelStateSchema, { owner: snapshot.owner, panelId: snapshot.panelId, destinationId: view.destinationId, snapshot });
		// Expiry is wall-clock based; the authenticated host read drives the real sweep.
		setSystemTime(new Date(Date.now() + 15001));
		await ui(f.server.endpoint, `/v1/panels?clientId=${view.state.devices[0]!.id}&owner=${snapshot.owner}&panelId=${snapshot.panelId}`, z.object({ closed: z.literal(true) }));
		const state = await stateWhen(client, state => state.panels.some(panel => panel.panelId === snapshot.panelId && panel.phase === "closed"));
		expect(Date.now() - publishedAt).toBeGreaterThanOrEqual(15000);
		expect(state.transfers.find(item => item.id === transfer.id)?.phase).toBe("ready");
		const claim = await f.broker.claimIntent(intent.id, view.sessionId, view.draftToken, view.destinationId);
		expect(await readFile(claim.files![0]!.path, "utf8")).toBe("retained upload");
		await f.broker.finishIntent(intent.id);
		await stateWhen(client, state => state.transfers.some(item => item.id === transfer.id && item.phase === "attached"));
	} finally { setSystemTime(); await f.close(); }
}, 45000);

test("owned draft channels reconnect with a new locator and retain only the current token", async () => {
	const root = await mkdtemp(join(tmpdir(), "draft-channel-reconnect-"));
	let server = await startBroker({ stateDir: root });
	const broker = new BrokerClient({ stateDir: root });
	const first = Promise.withResolvers<DraftDestination>();
	const replacement = Promise.withResolvers<DraftDestination>();
	const revoked = Promise.withResolvers<void>();
	const delivered = Promise.withResolvers<DraftIntent>();
	const destinations: DraftDestination[] = [];
	const channel = broker.openDraft("native-session", "initial-token", {
		onDestination(value) {
			if (!value) { if (destinations.length) revoked.resolve(); return; }
			destinations.push(value); (destinations.length === 1 ? first : replacement).resolve(value);
		},
		onIntent(intent) { delivered.resolve(intent); },
		onError() {},
	});
	channel.update("current-token");
	let writer: PairedFixture | undefined;
	try {
		const initial = await first.promise;
		expect(initial.draftToken).toBe("current-token");
		await server.close(); await revoked.promise;
		server = await startBroker({ stateDir: root });
		const current = await replacement.promise;
		expect(current.id).not.toBe(initial.id);
		expect(current.serverInstance).not.toBe(initial.serverInstance);
		expect(current.draftToken).toBe("current-token");
		writer = await paired(server.endpoint, join(root, "reconnected-client"));
		await expect(writer.peer.request("ui.intent", { kind: "resolve", viewId: "reconnected-view", destinationId: initial.id })).rejects.toMatchObject({ code: "DESTINATION_CHANGED" });
		const receipt = UiIntentReceiptSchema.parse(await writer.peer.request("ui.intent", { kind: "resolve", viewId: "reconnected-view", destinationId: current.id }));
		const intent = await delivered.promise;
		expect(intent).toMatchObject({ id: receipt.id, destinationId: current.id, draftToken: "current-token" });
		await broker.claimIntent(intent.id, intent.sessionId, intent.draftToken, intent.destinationId);
		await broker.finishIntent(intent.id);
	} finally { writer?.close(); channel.close(); broker.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
}, 30000);

test("panel capacity is reclaimed and only explicit open can create after closure quarantine", async () => {
	const f = await fixture(0);
	const writer = await paired(f.server.endpoint, join(f.root, "capacity-client"));
	try {
		setSystemTime(new Date());
		const destinationId = draftOwners.get(f.broker)!.destination.id;
		const input = (panelId: string) => ({ owner: "capacity-owner", panelId, destinationId, snapshot: { owner: "capacity-owner", panelId, source: "Client", target: "OMP", agent: "Unbound", connected: true, devices: [], transfers: [], approvals: 0 } });
		for (let index = 0; index < 4096; index++) await writer.peer.request("panel.open", input(`panel-${index}`));
		await expect(writer.peer.request("panel.open", input("overflow"))).rejects.toMatchObject({ code: "BUSY" });
		await writer.peer.request("panel.close", { owner: "capacity-owner", panelId: "panel-0" });
		expect(PanelStateSchema.parse(await writer.peer.request("panel.open", input("overflow"))).phase).toBe("waiting");
		await expect(writer.peer.request("panel.publish", input("panel-0"))).rejects.toMatchObject({ code: "PANEL_CLOSED" });
		await expect(writer.peer.request("panel.open", input("panel-0"))).rejects.toMatchObject({ code: "PANEL_CLOSED" });
		setSystemTime(new Date(Date.now() + 15001));
		await expect(writer.peer.request("panel.publish", input("panel-1"))).rejects.toMatchObject({ code: "PANEL_CLOSED" });
		expect(PanelStateSchema.parse(await writer.peer.request("panel.open", input("after-expiry"))).phase).toBe("waiting");
		setSystemTime(new Date(Date.now() + 60001));
		await expect(writer.peer.request("panel.publish", input("panel-0"))).rejects.toMatchObject({ code: "PANEL_CLOSED" });
		expect(PanelStateSchema.parse(await writer.peer.request("panel.open", input("panel-0"))).phase).toBe("waiting");
	} finally { setSystemTime(); writer.close(); await f.close(); }
}, 120000);
