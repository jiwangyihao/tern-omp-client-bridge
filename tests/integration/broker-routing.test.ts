// SPDX-License-Identifier: MPL-2.0
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { startBroker } from "../../src/broker.ts";
import { BrokerClient } from "../../src/broker-client.ts";
import { startClientService, type ClientService } from "../../src/client.ts";
import { loadClientIdentity, type Endpoint } from "../../src/config.ts";
import { ControlFrameDecoder } from "../../src/control-frame.ts";
import { CaptureResultSchema, LocalUiStateSchema, TransferStatusSchema, UiIntentReceiptSchema } from "../../src/schemas.ts";
import type { LocalUiState } from "../../src/api.ts";
import type { ToolResult } from "../../src/protocol.ts";

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

async function fixture(count: number) {
	const root = await mkdtemp(join(tmpdir(), "bridge-routing-"));
	const server = await startBroker({ stateDir: join(root, "server") });
	const broker = new BrokerClient({ endpoint: server.endpoint });
	const clients: ClientService[] = [];
	try {
		for (let index = 0; index < count; index++) {
			const stateDir = join(root, `client-${index}`);
			const cwd = join(root, `files-${index}`); await mkdir(cwd);
			const identity = await loadClientIdentity(stateDir, { name: `Synthetic client ${index}`, capabilities: ["files", "exec"] });
			clients.push(await startClientService({ stateDir, cwd, identity, serverName: "Synthetic broker", connection: { kind: "loopback", endpoint: server.endpoint } }));
		}
		await Promise.all(clients.map(client => client.waitForConnection(AbortSignal.timeout(20000))));
		return { root, server, broker, clients, close: async () => { broker.close(); const results = await Promise.allSettled([server.close(), ...clients.map(client => client.close())]); await rm(root, { recursive: true, force: true }); const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []); if (errors.length) throw new AggregateError(errors, "Fixture cleanup failed"); } };
	} catch (error) { broker.close(); await Promise.allSettled([server.close(), ...clients.map(client => client.close())]); await rm(root, { recursive: true, force: true }); throw error; }
}
async function resolveView(client: ClientService, broker: BrokerClient, viewId: string, sessionId = "conversation", draftToken = "draft") {
	const receipt = await ui(client.endpoint, "/v1/intents", UiIntentReceiptSchema, { kind: "resolve", viewId });
	await broker.claimIntent(receipt.id, sessionId, draftToken); await broker.finishIntent(receipt.id);
	const state = await stateWhen(client, state => state.views[viewId]?.resolveIntentId === receipt.id);
	return state.views[viewId]!;
}
async function bind(client: ClientService, broker: BrokerClient, viewId: string, clientId: string | null, expectedRevision: number) {
	const receipt = await ui(client.endpoint, "/v1/intents", UiIntentReceiptSchema, { kind: "bind", viewId, sessionId: "conversation", clientId, expectedRevision });
	const result = await broker.claimIntent(receipt.id, "conversation", "draft"); await broker.finishIntent(receipt.id);
	return result.state;
}

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
		const stale = await ui(b!.endpoint, "/v1/intents", UiIntentReceiptSchema, { kind: "bind", viewId: "view-1", sessionId: "conversation", clientId: identities[2]!.device.id, expectedRevision: 0 });
		await bind(a!, f.broker, "view-0", identities[1]!.device.id, 0);
		await expect(f.broker.claimIntent(stale.id, "conversation", "draft")).rejects.toMatchObject({ code: "STALE_BINDING" });
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
			if (ready.phase !== "ready" || !ready.frame) throw new Error(ready.error ?? "No attachment frame was prepared");
			const [intentId] = new ControlFrameDecoder().push(ready.frame).intentIds;
			if (!intentId) throw new Error("The attachment did not carry a valid control intent");
			return { transfer: ready, intentId };
		};
		const first = await start();
		expect((await f.broker.state("conversation")).binding.clientId).toBeNull();
		const destination = join(f.root, "server", "imports", first.transfer.id);
		const filename = (await readdir(destination)).find(name => name !== "README");
		expect(await readFile(join(destination, filename!))).toEqual(bytes);
		await ui(client.endpoint, "/v1/transfers/cancel", Ok, { id: first.transfer.id });
		await expect(f.broker.claimIntent(first.intentId, "conversation", "draft")).rejects.toMatchObject({ code: "INTENT_CONSUMED" });
		const second = await start();
		const claimed = await f.broker.claimIntent(second.intentId, "conversation", "draft");
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
		if (!ready.frame) throw new Error("Uploaded image has no native handoff frame");
		const [intentId] = new ControlFrameDecoder().push(ready.frame).intentIds;
		if (!intentId) throw new Error("Uploaded image has no valid handoff intent");
		const claimed = await f.broker.claimIntent(intentId, view.sessionId, view.draftToken);
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
