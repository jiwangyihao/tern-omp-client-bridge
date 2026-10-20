// SPDX-License-Identifier: MPL-2.0
import { afterEach, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { z } from "zod";
import { startClientService, type ClientServiceOptions } from "../../src/client.ts";
import { authorized, loadClientIdentity, readEndpoint, verifyIdentity, writePrivateJson, type Endpoint } from "../../src/config.ts";
import { encodeControlFrame } from "../../src/control-frame.ts";
import { BridgeError, type DeviceDescriptor, type ExecuteRequest, type ToolResult } from "../../src/protocol.ts";
import { DeviceDescriptorSchema, IdentifierSchema, ServerStateSchema, ToolResultSchema, UiIntentSchema } from "../../src/schemas.ts";
import { UploadStore } from "../../src/uploads.ts";
import { RpcPeer, type RpcContext } from "../../src/wire.ts";

const RegistrationSchema = z.object({ device: DeviceDescriptorSchema, publicKey: z.string(), signature: z.string() });
const RegistrationReplySchema = z.object({ device: DeviceDescriptorSchema, serverName: z.string(), serverInstance: z.string() });
const ReceiptSchema = z.object({ id: IdentifierSchema, frame: z.string(), expiresAt: z.number() });
const CaptureSchema = z.object({ id: IdentifierSchema, kind: z.literal("files"), names: z.array(z.string()) });
const TransferSchema = z.object({ id: IdentifierSchema, source: DeviceDescriptorSchema, viewId: IdentifierSchema, phase: z.string(), bytesSent: z.number(), totalBytes: z.number(), names: z.array(z.string()), frame: z.string().optional(), error: z.string().optional() });
const UiStateSchema = z.object({ device: DeviceDescriptorSchema, connected: z.boolean(), serverName: z.string(), views: z.record(z.string(), z.object({ viewId: z.string(), sessionId: z.string(), draftToken: z.string(), resolveIntentId: z.string(), state: ServerStateSchema })), transfers: z.array(TransferSchema), interactions: z.array(z.unknown()) });
const BeginSchema = z.object({ viewId: z.string(), sessionId: z.string(), draftToken: z.string(), files: z.array(z.object({ name: z.string(), size: z.number() })) });
const ChunkSchema = z.object({ id: z.string(), index: z.number(), offset: z.number(), data: z.string() });
const FinishSchema = z.object({ id: z.string(), sha256: z.array(z.string()) });
const IdSchema = z.object({ id: z.string() });
const BackgroundSchema = z.object({ requestId: z.string(), result: ToolResultSchema });
interface SocketData { peer?: RpcPeer; nonce: string }
interface FixtureOptions {
	beforeBegin?: () => Promise<void>;
	beforeChunk?: (context: RpcContext) => Promise<void>;
	corruptDigest?: boolean;
	beforeRegister?: (peer: RpcPeer) => Promise<void>;
	cancelTooLate?: boolean;
	capabilities?: DeviceDescriptor["capabilities"];
	readClipboardImage?: ClientServiceOptions["readClipboardImage"];
}
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
}, 20_000);

/** A real authenticated protocol peer and real file upload store; native runtime is never replaced. */
async function fixture(options: FixtureOptions = {}) {
	const root = await mkdtemp(join(tmpdir(), "client-service-"));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const identity = await loadClientIdentity(join(root, "identity"), { name: "Synthetic client", capabilities: options.capabilities ?? ["files", "exec", "computer"] });
	const uploads = new UploadStore(join(root, "imports"));
	cleanup.push(() => uploads.close());
	const firstRegistration = Promise.withResolvers<RpcPeer>();
	const nextRegistration = Promise.withResolvers<RpcPeer>();
	const attachment = Promise.withResolvers<z.infer<typeof ReceiptSchema>>();
	const cancelled = Promise.withResolvers<string>();
	const background = Promise.withResolvers<z.infer<typeof BackgroundSchema>>();
	const resultOrder: string[] = [];
	const intentKinds = new Map<string, string>();
	const chunkLengths: number[] = [];
	const sockets = new Set<ServerWebSocket<SocketData>>();
	const token = randomBytes(32).toString("hex");
	let registrations = 0;
	let begins = 0;
	let activePeer: RpcPeer | undefined;
	let serverInstance = crypto.randomUUID();
	const server = Bun.serve<SocketData>({ hostname: "127.0.0.1", port: 0, fetch(request, server) {
		if (!authorized(request, token)) return new Response("unauthorized", { status: 401 });
		if (new URL(request.url).pathname === "/v1/connect" && server.upgrade(request, { data: { nonce: randomBytes(32).toString("hex") } })) return;
		return new Response("not found", { status: 404 });
	}, websocket: {
		open(socket) {
			sockets.add(socket);
			const peer = new RpcPeer(frame => {
				socket.send(JSON.stringify(frame));
				if (frame.kind !== "result" || !frame.ok) return;
				const registration = RegistrationReplySchema.safeParse(frame.body);
				if (registration.success) {
					registrations++;
					activePeer = peer;
					(registrations === 1 ? firstRegistration : nextRegistration).resolve(peer);
				}
				const receipt = ReceiptSchema.safeParse(frame.body);
				if (receipt.success && intentKinds.get(receipt.data.id) === "attach") attachment.resolve(receipt.data);
			}, async (method, body, context) => {
				if (method === "register") {
					const input = RegistrationSchema.parse(body);
					expect(verifyIdentity(socket.data.nonce, input.device, input.publicKey, input.signature)).toBe(true);
					expect<DeviceDescriptor>(input.device).toEqual(identity.device);
					await options.beforeRegister?.(peer);
					return { device: input.device, serverName: "Synthetic server", serverInstance };
				}
				if (method === "ui.intent") {
					const input = UiIntentSchema.parse(body);
					if (input.kind === "attach") {
						const uploaded = uploads.completed(identity.device.id, input.transferId);
						expect(uploaded.sessionId).toBe(input.sessionId);
						expect(uploaded.draftToken).toBe(input.draftToken);
					}
					const id = crypto.randomUUID();
					intentKinds.set(id, input.kind);
					return { id, frame: encodeControlFrame(id), expiresAt: Date.now() + 60000 };
				}
				if (method === "upload.begin") { begins++; await options.beforeBegin?.(); return uploads.begin(identity.device.id, BeginSchema.parse(body)); }
				if (method === "upload.chunk") {
					const input = ChunkSchema.parse(body);
					chunkLengths.push(Buffer.from(input.data, "base64").length);
					await options.beforeChunk?.(context);
					context.signal.throwIfAborted();
					return uploads.chunk(identity.device.id, input, context.signal);
				}
				if (method === "upload.finish") {
					const input = FinishSchema.parse(body);
					const completed = await uploads.finish(identity.device.id, input.id, input.sha256);
					return { files: completed.files.map(file => options.corruptDigest ? { ...file, sha256: "0".repeat(64) } : file) };
				}
				if (method === "upload.cancel") {
					const { id } = IdSchema.parse(body);
					if (options.cancelTooLate) throw new BridgeError("CANCEL_TOO_LATE", "Native handoff may already have occurred; cancellation outcome is uncertain");
					await uploads.cancel(identity.device.id, id); cancelled.resolve(id); return { ok: true };
				}
				throw new BridgeError("UNSUPPORTED_METHOD", method);
			}, (name, body) => {
				if (name === "tool.background") { resultOrder.push("background"); background.resolve(BackgroundSchema.parse(body)); }
			});
			socket.data.peer = peer;
			peer.notify("challenge", { nonce: socket.data.nonce });
		},
		message(socket, data) {
			const value: unknown = JSON.parse(typeof data === "string" ? data : data.toString());
			const result = ResultFrameSchema.safeParse(value);
			if (result.success && result.data.ok && ToolResultSchema.safeParse(result.data.body).success) resultOrder.push("result");
			socket.data.peer!.receive(value);
		},
		close(socket) { sockets.delete(socket); socket.data.peer?.close(); },
	} });
	cleanup.push(async () => { for (const socket of sockets) socket.close(); await server.stop(true); });
	const client = await startClientService({ identity, readClipboardImage: options.readClipboardImage, stateDir: join(root, "client"), cwd: root, serverName: "Synthetic server", connection: { kind: "loopback", endpoint: { url: `http://127.0.0.1:${server.port}`, token } } });
	cleanup.push(() => client.close());
	const peer = await firstRegistration.promise;
	await client.waitForConnection();
	async function api(route: string, body?: unknown) {
		const response = await fetch(client.endpoint.url + route, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${client.endpoint.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
		const value: unknown = await response.json();
		return { response, value };
	}
	async function resolveView(viewId = "window:host-tagged-pane", sessionId = "conversation", draftToken = "draft") {
		const { value, response } = await api("/v1/intents", { kind: "resolve", viewId });
		expect(response.ok).toBe(true);
		const receipt = ReceiptSchema.parse(value);
		const view = { viewId, resolveIntentId: receipt.id, sessionId, draftToken, state: { serverInstance, binding: { sessionId, clientId: null, revision: 0, change: null }, devices: [{ ...identity.device, online: true }] } };
		if (!activePeer) throw new Error("Fixture connection unavailable");
		activePeer.notify("view.resolved", view);
		await activePeer.request("context.close", { contextId: "view-event-barrier" });
		return { viewId, expectedSessionId: sessionId, expectedDraftToken: draftToken, expectedResolveIntentId: receipt.id };
	}
	function invocation(tool: ExecuteRequest["tool"], params: ExecuteRequest["params"]): ExecuteRequest {
		return { target: { requestId: crypto.randomUUID(), sessionId: "conversation", contextId: "native-context", bindingRevision: 1, device: identity.device }, tool, params };
	}
	return { root, identity, uploads, client, peer, api, resolveView, invocation, attachment, cancelled, background, resultOrder, chunkLengths, get begins() { return begins; }, async reconnect(restarted = false) {
		if (restarted) serverInstance = crypto.randomUUID();
		for (const socket of sockets) socket.close();
		const current = await nextRegistration.promise;
		await client.waitForConnection();
		return current;
	} };
}
const ResultFrameSchema = z.object({ kind: z.literal("result"), ok: z.boolean(), body: z.unknown() });

function text(result: ToolResult): string {
	return result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
}

test("local capture rejects clipboard commands and malformed requests before capture or upload", async () => {
	const f = await fixture();
	for (const body of [{ kind: "clipboard" }, { kind: "clipboard", approved: true }, { kind: "clipboard", paths: [] }, {}, null, { kind: "files", paths: [] }, { kind: "files", paths: [null] }, { kind: "files", paths: ["/synthetic/file"], clipboard: true }]) {
		const { response, value } = await f.api("/v1/captures", body);
		expect(response.status).toBe(400);
		expect(value).toMatchObject({ code: "INVALID_INPUT" });
	}
	expect(f.begins).toBe(0);
	expect(UiStateSchema.parse((await f.api("/v1/state")).value).transfers).toEqual([]);
	await expect(stat(join(f.root, "client", "captures"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("image capture requires a pending local choice, never a request approval flag or remote method", async () => {
	let reads = 0;
	const f = await fixture({ capabilities: [], readClipboardImage: async () => { reads++; return null; } });
	expect((await f.api("/v1/captures/image", { kind: "image", approved: true })).value).toMatchObject({ code: "INVALID_INPUT" });
	expect((await f.api("/v1/captures/image", { kind: "image" })).value).toMatchObject({ code: "CAPTURE_DENIED" });
	await expect(f.peer.request("capture.image", { approved: true })).rejects.toThrow("Only native tool execution");
	await f.api("/v1/state");
	const capturing = f.api("/v1/captures/image", { kind: "image" });
	const approval = await pendingImageApproval(f);
	expect(reads).toBe(0);
	expect((await f.api("/v1/interactions/reply", { id: approval.id, choice: null })).response.ok).toBe(true);
	expect((await capturing).value).toMatchObject({ code: "CAPTURE_DENIED" });
	expect(reads).toBe(0);
	expect(f.begins).toBe(0);
	await expect(stat(join(f.root, "client", "captures"))).rejects.toMatchObject({ code: "ENOENT" });
});

async function pendingImageApproval(f: { api(route: string, body?: unknown): Promise<{ response: Response; value: unknown }> }) {
	for (let attempt = 0; attempt < 200; attempt++) {
		const state = UiStateSchema.parse((await f.api("/v1/state")).value);
		if (state.interactions.length) return z.object({ id: z.string(), choices: z.array(z.object({ id: z.string() })) }).parse(state.interactions[0]);
	}
	throw new Error("Image approval did not become locally visible");
}

test("one approved image snapshot uploads while unbound with no agent capabilities", async () => {
	let reads = 0;
	const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=", "base64");
	const f = await fixture({ capabilities: [], readClipboardImage: async () => { reads++; return { data: bytes, mimeType: "image/png" }; } });
	const destination = await f.resolveView();
	await f.api("/v1/state");
	const capturing = f.api("/v1/captures/image", { kind: "image" });
	const approval = await pendingImageApproval(f);
	expect(reads).toBe(0);
	await f.api("/v1/interactions/reply", { id: approval.id, choice: "capture-image" });
	const capture = CaptureSchema.parse((await capturing).value);
	expect(capture.names).toEqual(["clipboard.png"]);
	expect(reads).toBe(1);
	expect((await f.api("/v1/interactions/reply", { id: approval.id, choice: "capture-image" })).value).toMatchObject({ code: "INTERACTION_EXPIRED" });
	const transfer = TransferSchema.parse((await f.api("/v1/transfers", { ...destination, captureId: capture.id })).value);
	await f.attachment.promise;
	const imported = f.uploads.completed(f.identity.device.id, transfer.id);
	expect(imported.files[0]!.name).toBe("clipboard.png");
	expect(imported.files[0]!.path.endsWith(".png")).toBe(true);
	expect(await readFile(imported.files[0]!.path)).toEqual(bytes);
	expect(reads).toBe(1);
});

test("dropped images are admitted as real file uploads without agent authorization", async () => {
	const f = await fixture({ capabilities: [] });
	const path = join(f.root, "dropped.png");
	const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
	await writeFile(path, bytes);
	const capture = CaptureSchema.parse((await f.api("/v1/captures", { kind: "files", paths: [path] })).value);
	const destination = await f.resolveView();
	const transfer = TransferSchema.parse((await f.api("/v1/transfers", { ...destination, captureId: capture.id })).value);
	await f.attachment.promise;
	expect(await readFile(f.uploads.completed(f.identity.device.id, transfer.id).files[0]!.path)).toEqual(bytes);
	expect(await readFile(path)).toEqual(bytes);
});

test("approved empty clipboard reports no image and disconnect denies a waiting read", async () => {
	let reads = 0;
	const f = await fixture({ capabilities: [], readClipboardImage: async () => { reads++; return undefined; } });
	await f.api("/v1/state");
	const empty = f.api("/v1/captures/image", { kind: "image" });
	const approval = await pendingImageApproval(f);
	await f.api("/v1/interactions/reply", { id: approval.id, choice: "capture-image" });
	expect((await empty).value).toMatchObject({ code: "NO_CLIPBOARD_IMAGE" });
	const abandoned = f.api("/v1/captures/image", { kind: "image" });
	await pendingImageApproval(f);
	await f.reconnect();
	expect((await abandoned).response.ok).toBe(false);
	expect(reads).toBe(1);
	expect(f.begins).toBe(0);
});

test("disconnect during an approved native read discards its late bytes without taking a snapshot", async () => {
	const entered = Promise.withResolvers<void>();
	const image = Promise.withResolvers<{ data: Uint8Array; mimeType: string }>();
	const f = await fixture({ capabilities: [], readClipboardImage: () => { entered.resolve(); return image.promise; } });
	await f.api("/v1/state");
	const capturing = f.api("/v1/captures/image", { kind: "image" });
	const approval = await pendingImageApproval(f);
	await f.api("/v1/interactions/reply", { id: approval.id, choice: "capture-image" });
	await entered.promise;
	await f.reconnect();
	expect((await capturing).response.ok).toBe(false);
	image.resolve({ data: new Uint8Array([137, 80, 78, 71]), mimeType: "image/png" });
	await f.api("/v1/state");
	expect(f.begins).toBe(0);
	await expect(stat(join(f.root, "client", "captures"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("local HTTP is authenticated, rejects browser origins and preserves replacement control metadata", async () => {
	const f = await fixture();
	expect((await fetch(f.client.endpoint.url + "/v1/state")).status).toBe(401);
	expect((await fetch(f.client.endpoint.url + "/v1/state", { headers: { authorization: `Bearer ${f.client.endpoint.token}`, origin: "http://127.0.0.1" } })).status).toBe(401);
	const state = UiStateSchema.parse((await f.api("/v1/state")).value);
	expect(state.connected).toBe(true);
	expect(state.device.id).toBe(f.identity.device.id);
	expect(state.views).toEqual({});
	const control = join(f.root, "client", "client.json");
	expect(await readEndpoint(control)).toEqual(f.client.endpoint);
	if (process.platform !== "win32") expect((await stat(control)).mode & 0o777).toBe(0o600);
	const replacement: Endpoint = { url: "http://127.0.0.1:12345", token: "replacement-owned-metadata" };
	await writePrivateJson(control, replacement);
	await f.client.close();
	expect(await readEndpoint(control)).toEqual(replacement);
});

test("signed registration allows pending disposal but rejects execution before registration", async () => {
	let attempted = false;
	await fixture({ beforeRegister: async peer => {
		expect(await peer.request("context.close", { contextId: "offline-closed-context" })).toEqual({ ok: true });
		await expect(peer.request("execute", {})).rejects.toThrow("signed client registration");
		attempted = true;
	} });
	expect(attempted).toBe(true);
});

test("real tools mutate only their client files and duplicate invocation IDs remain rejected after reconnect", async () => {
	const f = await fixture();
	const target = join(f.root, "native 文件.txt");
	const invocation = f.invocation("write", { path: target, content: "first side effect" });
	const result = ToolResultSchema.parse(await f.peer.request("execute", invocation));
	expect(result.isError).not.toBe(true);
	expect(await readFile(target, "utf8")).toBe("first side effect");
	await writeFile(target, "human replacement");
	await f.peer.request("execute", f.invocation("eval", { language: "js", code: "globalThis.retainedAcrossReconnect = 42" }));
	const reconnected = await f.reconnect();
	await expect(reconnected.request("execute", invocation)).rejects.toThrow("cannot be replayed");
	expect(await readFile(target, "utf8")).toBe("human replacement");
	const retained = ToolResultSchema.parse(await reconnected.request("execute", f.invocation("eval", { language: "js", code: "display(retainedAcrossReconnect)" })));
	expect(text(retained)).toContain("42");
	const foreign = f.invocation("write", { path: target, content: "wrong device" });
	await expect(reconnected.request("execute", { ...foreign, target: { ...foreign.target, device: { ...foreign.target.device, id: "another-client" } } })).rejects.toThrow("another client");
	await expect(reconnected.request("capture", { kind: "clipboard" })).rejects.toThrow("Only native tool execution");
}, 90000);

test("without a live local UI, remote approval flags cannot authorize a native desktop prelude", async () => {
	const f = await fixture();
	// Native approval denies before opening a desktop backend. No real desktop is used.
	const result = ToolResultSchema.parse(await f.peer.request("execute", f.invocation("eval", { language: "js", code: "await computer.capabilities()", approved: true, timeout: 15 })));
	expect(result.isError).toBe(true);
	expect(text(result)).toMatch(/denied|approval/i);
	const state = UiStateSchema.parse((await f.api("/v1/state")).value);
	expect(state.interactions).toEqual([]);
	expect((await f.api("/v1/interactions/reply", { id: "invented", choice: "yes" })).response.ok).toBe(false);
}, 90000);

test("captured bytes and empty-file digests upload incrementally to the original unbound draft", async () => {
	const f = await fixture();
	const input = join(f.root, "selected 图.bin");
	const empty = join(f.root, "empty file.txt");
	const bytes = randomBytes(768 * 1024 + 19);
	await writeFile(input, bytes); await writeFile(empty, "");
	const capture = CaptureSchema.parse((await f.api("/v1/captures", { kind: "files", paths: [input, empty] })).value);
	await writeFile(input, "later human content");
	const destination = await f.resolveView();
	const transfer = TransferSchema.parse((await f.api("/v1/transfers", { ...destination, captureId: capture.id })).value);
	expect(transfer.source.id).toBe(f.identity.device.id);
	expect(transfer.frame).toBeUndefined();
	const receipt = await f.attachment.promise;
	await f.peer.request("context.close", { contextId: "attachment-reply-barrier" });
	const state = UiStateSchema.parse((await f.api("/v1/state")).value);
	expect(state.transfers[0]).toMatchObject({ id: transfer.id, phase: "ready", bytesSent: bytes.length, totalBytes: bytes.length, frame: receipt.frame });
	const imported = f.uploads.completed(f.identity.device.id, transfer.id);
	expect(imported.sessionId).toBe(destination.expectedSessionId);
	expect(imported.draftToken).toBe(destination.expectedDraftToken);
	expect(await readFile(imported.files[0]!.path)).toEqual(bytes);
	expect(imported.files[1]!.sha256).toBe(createHash("sha256").digest("hex"));
	expect(f.chunkLengths.length).toBeGreaterThan(1);
	expect(f.chunkLengths.every(size => size > 0 && size <= 256 * 1024)).toBe(true);
	f.peer.notify("intent.finished", { id: receipt.id, viewId: destination.viewId, kind: "attach", error: "Native handoff outcome unknown; do not retry" });
	await f.peer.request("context.close", { contextId: "finished-event-barrier" });
	const failed = UiStateSchema.parse((await f.api("/v1/state")).value).transfers[0]!;
	expect(failed.phase).toBe("failed"); expect(failed.error).toContain("outcome unknown"); expect(failed.frame).toBeUndefined();
	expect(await readFile(input, "utf8")).toBe("later human content");
	expect(await readFile(imported.files[0]!.path)).toEqual(bytes);
});

for (const replacement of [
	{ name: "survives a same-draft handshake refresh", sessionId: "conversation", draftToken: "draft", allowed: true },
	{ name: "rejects a replacement conversation during initialization", sessionId: "another-conversation", draftToken: "draft", allowed: false },
	{ name: "rejects a replacement draft during initialization", sessionId: "conversation", draftToken: "another-draft", allowed: false },
]) {
	test(`admitted upload ${replacement.name}`, async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const f = await fixture({ beforeBegin: async () => { entered.resolve(); await release.promise; } });
		cleanup.push(async () => { release.resolve(); });
		const input = join(f.root, "admitted file.txt");
		const bytes = Buffer.from("original destination bytes\n");
		await writeFile(input, bytes);
		const capture = CaptureSchema.parse((await f.api("/v1/captures", { kind: "files", paths: [input] })).value);
		const original = await f.resolveView();
		const starting = f.api("/v1/transfers", { ...original, captureId: capture.id });
		try {
			await entered.promise;
			const refreshed = await f.resolveView(original.viewId, replacement.sessionId, replacement.draftToken);
			expect(refreshed.expectedResolveIntentId).not.toBe(original.expectedResolveIntentId);
			release.resolve();
			const result = await starting;
			if (replacement.allowed) {
				expect(result.response.ok).toBe(true);
				const transfer = TransferSchema.parse(result.value);
				await f.attachment.promise;
				await f.peer.request("context.close", { contextId: "refreshed-upload-barrier" });
				const imported = f.uploads.completed(f.identity.device.id, transfer.id);
				expect(imported.sessionId).toBe(original.expectedSessionId);
				expect(imported.draftToken).toBe(original.expectedDraftToken);
				expect(await readFile(imported.files[0]!.path)).toEqual(bytes);
				expect(UiStateSchema.parse((await f.api("/v1/state")).value).transfers[0]).toMatchObject({ id: transfer.id, phase: "ready", bytesSent: bytes.length });
			} else {
				expect(result.response.status).toBe(400);
				expect(result.value).toMatchObject({ code: "DESTINATION_CHANGED" });
				const cancelled = await f.cancelled.promise;
				expect(UiStateSchema.parse((await f.api("/v1/state")).value).transfers[0]).toMatchObject({ id: cancelled, phase: "failed" });
				expect(() => f.uploads.completed(f.identity.device.id, cancelled)).toThrow();
			}
			expect(await readFile(input)).toEqual(bytes);
		} finally { release.resolve(); await starting; }
	});
}

test("stale captured resolve IDs fail before upload and capture release never deletes originals", async () => {
	const f = await fixture();
	const input = join(f.root, "selected.txt"); await writeFile(input, "keep original");
	const capture = CaptureSchema.parse((await f.api("/v1/captures", { kind: "files", paths: [input] })).value);
	const old = await f.resolveView(); await f.resolveView();
	const rejected = await f.api("/v1/transfers", { ...old, captureId: capture.id });
	expect(rejected.response.ok).toBe(false); expect(f.begins).toBe(0);
	expect((await f.api("/v1/captures/release", { id: capture.id })).response.ok).toBe(true);
	expect(await readFile(input, "utf8")).toBe("keep original");
	const current = await f.resolveView();
	expect((await f.api("/v1/transfers", { ...current, captureId: capture.id })).response.ok).toBe(false);
});

test("destination changes cancel only the owned partial upload without an attach frame", async () => {
	const chunkStarted = Promise.withResolvers<void>();
	const f = await fixture({ beforeChunk: async context => {
		chunkStarted.resolve();
		const aborted = Promise.withResolvers<void>();
		if (context.signal.aborted) return;
		context.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
		await aborted.promise;
	} });
	const input = join(f.root, "selected.bin"); await writeFile(input, randomBytes(300000));
	const capture = CaptureSchema.parse((await f.api("/v1/captures", { kind: "files", paths: [input] })).value);
	const destination = await f.resolveView();
	const transfer = TransferSchema.parse((await f.api("/v1/transfers", { ...destination, captureId: capture.id })).value);
	await chunkStarted.promise;
	await f.resolveView(destination.viewId, "different-conversation", "different-draft");
	expect(await f.cancelled.promise).toBe(transfer.id);
	await f.peer.request("context.close", { contextId: "cancel-reply-barrier" });
	const item = UiStateSchema.parse((await f.api("/v1/state")).value).transfers[0]!;
	expect(["failed", "cancelled"]).toContain(item.phase);
	expect(item.frame).toBeUndefined();
	expect((await readdir(join(f.root, "imports"))).some(name => name.startsWith(transfer.id))).toBe(false);
	expect((await stat(input)).size).toBe(300000);
});

test("remote checksum mismatches never produce an attach intent or ready UI", async () => {
	const f = await fixture({ corruptDigest: true });
	const input = join(f.root, "selected.bin"); await writeFile(input, randomBytes(100));
	const capture = CaptureSchema.parse((await f.api("/v1/captures", { kind: "files", paths: [input] })).value);
	const destination = await f.resolveView();
	const transfer = TransferSchema.parse((await f.api("/v1/transfers", { ...destination, captureId: capture.id })).value);
	expect(await f.cancelled.promise).toBe(transfer.id);
	await f.peer.request("context.close", { contextId: "checksum-failure-barrier" });
	const item = UiStateSchema.parse((await f.api("/v1/state")).value).transfers[0]!;
	expect(item.phase).toBe("failed"); expect(item.frame).toBeUndefined(); expect(item.error).toContain("verification");
});

test("native background completion keeps its original invocation after a transport-only reconnect", async () => {
	const f = await fixture();
	const gate = Promise.withResolvers<Response>();
	const entered = Promise.withResolvers<void>();
	const fixtureServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { entered.resolve(); return gate.promise; } });
	cleanup.push(async () => { gate.resolve(new Response("released")); await fixtureServer.stop(true); });
	const script = join(f.root, "background-fixture.ts");
	await writeFile(script, `await fetch("http://127.0.0.1:${fixtureServer.port}/"); console.log("owned-background-completion");`);
	const command = `${JSON.stringify(process.execPath.replaceAll("\\", "/"))} ${JSON.stringify(script.replaceAll("\\", "/"))}`;
	const call = f.invocation("bash", { command, async: true, timeout: 30 });
	const result = ToolResultSchema.parse(await f.peer.request("execute", call));
	expect(result.isError).not.toBe(true);
	await entered.promise;
	await f.reconnect();
	gate.resolve(new Response("release"));
	const completion = await f.background.promise;
	expect(completion.requestId).toBe(call.target.requestId);
	expect(text(completion.result)).toContain("owned-background-completion");
	expect(f.resultOrder.indexOf("result")).toBeLessThan(f.resultOrder.indexOf("background"));
}, 90000);

test("service stays available offline and does not queue local intents", async () => {
	const root = await mkdtemp(join(tmpdir(), "client-offline-"));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("unused") });
	const remote = { url: `http://127.0.0.1:${reservation.port}`, token: randomBytes(32).toString("hex") };
	await reservation.stop(true);
	const identity = await loadClientIdentity(join(root, "identity"), { name: "Offline synthetic client", capabilities: [] });
	const client = await startClientService({ identity, stateDir: join(root, "client"), serverName: "Unavailable server", connection: { kind: "loopback", endpoint: remote } });
	cleanup.push(() => client.close());
	const headers = { authorization: `Bearer ${client.endpoint.token}`, "content-type": "application/json" };
	const state = UiStateSchema.parse(await (await fetch(client.endpoint.url + "/v1/state", { headers })).json());
	expect(state.connected).toBe(false);
	const intent = await fetch(client.endpoint.url + "/v1/intents", { method: "POST", headers, body: JSON.stringify({ kind: "resolve", viewId: "offline-view" }) });
	expect(intent.status).toBe(503);
	const controller = new AbortController();
	const aborted = client.waitForConnection(controller.signal);
	controller.abort(new Error("fixture connection wait cancelled"));
	await expect(aborted).rejects.toThrow("fixture connection wait cancelled");
	const closingWait = client.waitForConnection().catch((error: unknown) => error);
	await client.close();
	expect(await closingWait).toMatchObject({ code: "CLIENT_CLOSED" });
	await expect(client.waitForConnection()).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
	await expect(readEndpoint(join(root, "client", "client.json"))).rejects.toMatchObject({ code: "BRIDGE_UNAVAILABLE" });
});

test("verified attachment completion becomes attached without removing source or referenced remote bytes", async () => {
	const f = await fixture();
	const input = join(f.root, "attachment.txt"); await writeFile(input, "draft-only attachment");
	const capture = CaptureSchema.parse((await f.api("/v1/captures", { kind: "files", paths: [input] })).value);
	const destination = await f.resolveView();
	const transfer = TransferSchema.parse((await f.api("/v1/transfers", { ...destination, captureId: capture.id })).value);
	const receipt = await f.attachment.promise;
	await f.peer.request("context.close", { contextId: "attachment-ready-barrier" });
	f.peer.notify("intent.finished", { id: receipt.id, viewId: destination.viewId, kind: "attach" });
	await f.peer.request("context.close", { contextId: "attachment-completed-barrier" });
	const item = UiStateSchema.parse((await f.api("/v1/state")).value).transfers[0]!;
	expect(item.phase).toBe("attached"); expect(item.frame).toBeUndefined();
	expect((await f.api("/v1/transfers/cancel", { id: transfer.id })).response.ok).toBe(false);
	const remote = f.uploads.completed(f.identity.device.id, transfer.id).files[0]!.path;
	await f.client.close();
	expect(await readFile(input, "utf8")).toBe("draft-only attachment");
	expect(await readFile(remote, "utf8")).toBe("draft-only attachment");
});

test("releasing an uploading capture cancels its own remote partial and preserves selected originals", async () => {
	const entered = Promise.withResolvers<void>();
	const f = await fixture({ beforeChunk: async context => {
		entered.resolve();
		const aborted = Promise.withResolvers<void>();
		if (context.signal.aborted) return;
		context.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
		await aborted.promise;
	} });
	const input = join(f.root, "cancelled selection.bin"); await writeFile(input, randomBytes(100));
	const capture = CaptureSchema.parse((await f.api("/v1/captures", { kind: "files", paths: [input] })).value);
	const destination = await f.resolveView();
	const transfer = TransferSchema.parse((await f.api("/v1/transfers", { ...destination, captureId: capture.id })).value);
	await entered.promise;
	expect((await f.api("/v1/captures/release", { id: capture.id })).response.ok).toBe(true);
	expect(await f.cancelled.promise).toBe(transfer.id);
	const item = UiStateSchema.parse((await f.api("/v1/state")).value).transfers[0]!;
	expect(item.phase).toBe("cancelled"); expect(item.frame).toBeUndefined();
	expect((await stat(input)).size).toBe(100);
	expect((await readdir(join(f.root, "imports"))).some(name => name.startsWith(transfer.id))).toBe(false);
});

test("broker instance changes dispose old native contexts and invalidate resolved drafts before readiness", async () => {
	const f = await fixture();
	await f.peer.request("execute", f.invocation("eval", { language: "js", code: "globalThis.oldBrokerState = 91" }));
	const input = join(f.root, "restart selection.txt"); await writeFile(input, "preserve original");
	const capture = CaptureSchema.parse((await f.api("/v1/captures", { kind: "files", paths: [input] })).value);
	const destination = await f.resolveView();
	const transfer = TransferSchema.parse((await f.api("/v1/transfers", { ...destination, captureId: capture.id })).value);
	await f.attachment.promise;
	await f.peer.request("context.close", { contextId: "ready-receipt-barrier" });
	const reconnected = await f.reconnect(true);
	const state = UiStateSchema.parse((await f.api("/v1/state")).value);
	expect(state.connected).toBe(true); expect(state.views).toEqual({});
	expect(state.transfers[0]).toMatchObject({ id: transfer.id, phase: "failed" });
	expect(state.transfers[0]!.frame).toBeUndefined();
	expect(state.transfers[0]!.error).toContain("broker restarted");
	const fresh = ToolResultSchema.parse(await reconnected.request("execute", f.invocation("eval", { language: "js", code: "display(typeof oldBrokerState)" })));
	expect(text(fresh)).toContain("undefined");
	expect(await readFile(input, "utf8")).toBe("preserve original");
}, 90000);

test("too-late cancellation stays uncertain across repeated clicks and later accepts confirmed handoff", async () => {
	const f = await fixture({ cancelTooLate: true });
	const input = join(f.root, "already claimed.txt"); await writeFile(input, "retain verified asset");
	const capture = CaptureSchema.parse((await f.api("/v1/captures", { kind: "files", paths: [input] })).value);
	const destination = await f.resolveView();
	const transfer = TransferSchema.parse((await f.api("/v1/transfers", { ...destination, captureId: capture.id })).value);
	const receipt = await f.attachment.promise;
	await f.peer.request("context.close", { contextId: "claim-result-barrier" });
	for (let attempt = 0; attempt < 2; attempt++) {
		const cancellation = await f.api("/v1/transfers/cancel", { id: transfer.id });
		expect(cancellation.response.ok).toBe(false);
		const item = UiStateSchema.parse((await f.api("/v1/state")).value).transfers[0]!;
		expect(item.phase).toBe("failed"); expect(item.error).toContain("uncertain"); expect(item.frame).toBeUndefined();
	}
	f.peer.notify("intent.finished", { id: receipt.id, viewId: destination.viewId, kind: "attach" });
	await f.peer.request("context.close", { contextId: "late-handoff-confirmation" });
	const confirmed = UiStateSchema.parse((await f.api("/v1/state")).value).transfers[0]!;
	expect(confirmed.phase).toBe("attached"); expect(confirmed.error).toBeUndefined();
	const imported = f.uploads.completed(f.identity.device.id, transfer.id);
	expect(await readFile(imported.files[0]!.path, "utf8")).toBe("retain verified asset");
});

test("closing during a pending WebSocket handshake aborts the owned connection without waiting for the peer", async () => {
	const root = await mkdtemp(join(tmpdir(), "client-pending-handshake-"));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<Response>();
	const remote = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { entered.resolve(); return release.promise; } });
	cleanup.push(async () => { release.resolve(new Response("handshake ended", { status: 503 })); await remote.stop(true); });
	const identity = await loadClientIdentity(join(root, "identity"), { name: "Handshake fixture", capabilities: [] });
	const client = await startClientService({ identity, stateDir: join(root, "client"), serverName: "Pending server", connection: { kind: "loopback", endpoint: { url: `http://127.0.0.1:${remote.port}`, token: randomBytes(32).toString("hex") } } });
	cleanup.push(() => client.close());
	await entered.promise;
	const connection = client.waitForConnection().catch((error: unknown) => error);
	await client.close();
	expect(await connection).toMatchObject({ code: "CLIENT_CLOSED" });
	await expect(readEndpoint(join(root, "client", "client.json"))).rejects.toMatchObject({ code: "BRIDGE_UNAVAILABLE" });
	// The remote handshake was deliberately still pending throughout close().
	release.resolve(new Response("released after client shutdown", { status: 503 }));
});

test("registered broker generation rejects retired view/state events and resets revision ordering", async () => {
	const f = await fixture();
	const destination = await f.resolveView();
	const oldView = UiStateSchema.parse((await f.api("/v1/state")).value).views[destination.viewId]!;
	const selected = { ...oldView.state, binding: { ...oldView.state.binding, clientId: f.identity.device.id, revision: 5 } };
	f.peer.notify("state", { sessionId: oldView.sessionId, state: selected });
	await f.peer.request("context.close", { contextId: "selected-state-barrier" });
	expect(UiStateSchema.parse((await f.api("/v1/state")).value).views[destination.viewId]!.state).toEqual(selected);
	f.peer.notify("state", { sessionId: oldView.sessionId, state: oldView.state });
	await f.peer.request("context.close", { contextId: "stale-revision-barrier" });
	expect(UiStateSchema.parse((await f.api("/v1/state")).value).views[destination.viewId]!.state).toEqual(selected);
	const replacement = await f.reconnect(true);
	expect(UiStateSchema.parse((await f.api("/v1/state")).value).views).toEqual({});
	await f.resolveView();
	const freshView = UiStateSchema.parse((await f.api("/v1/state")).value).views[destination.viewId]!;
	expect(freshView.state.serverInstance).not.toBe(oldView.state.serverInstance);
	expect(freshView.state.binding).toMatchObject({ clientId: null, revision: 0 });
	// Even a late payload on the current channel must belong to its signed registration.
	replacement.notify("state", { sessionId: oldView.sessionId, state: selected });
	replacement.notify("view.resolved", { ...freshView, state: selected });
	await replacement.request("context.close", { contextId: "retired-generation-barrier" });
	expect(UiStateSchema.parse((await f.api("/v1/state")).value).views[destination.viewId]).toEqual(freshView);
	const next = { ...freshView.state, binding: { ...freshView.state.binding, clientId: f.identity.device.id, revision: 1 } };
	replacement.notify("state", { sessionId: freshView.sessionId, state: next });
	await replacement.request("context.close", { contextId: "replacement-state-barrier" });
	expect(UiStateSchema.parse((await f.api("/v1/state")).value).views[destination.viewId]!.state).toEqual(next);
}, 30000);
