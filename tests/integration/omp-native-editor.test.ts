// SPDX-License-Identifier: MPL-2.0
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatVisionMarker } from "@oh-my-pi/pi-tui/prompt/composer-attachments";
import { imageAttachmentSource } from "@oh-my-pi/pi-tui/prompt/image-source";
import { Settings, resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { BrokerApi, ResolvedView, UiClaim } from "../../src/api.ts";
import { startBroker } from "../../src/broker.ts";
import { BrokerClient } from "../../src/broker-client.ts";
import { startClientService } from "../../src/client.ts";
import { loadClientIdentity } from "../../src/config.ts";
import { DraftBridge } from "../../src/omp/draft.ts";
import { INBOX_REMINDER } from "../../src/inbox-guidance.ts";
import { CaptureResultSchema, LocalUiStateSchema, TransferStatusSchema, UiIntentReceiptSchema } from "../../src/schemas.ts";
import { eventually, nativeDraftHost } from "../fixtures/native-draft.ts";
import { delayedAttachReceiptProxy } from "../fixtures/delayed-attach-receipt.ts";
import { getEditorTheme } from "@oh-my-pi/pi-tui/theme";
import { NativeAttachmentEditor } from "../../src/omp/native-attachment-editor.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
	resetSettingsForTest();
}, 20_000);

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfuoAAAAASUVORK5CYII=", "base64");

/** Real paired-client HTTP, broker draft sockets and installed OMP native editor/controllers. */
async function fixture(afterClaim?: (claim: UiClaim) => Promise<void>, delayAttachReceipt = false, delayCancellationReply = false) {
	const root = await mkdtemp(join(tmpdir(), "omp-native-draft-"));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	await Settings.init({ inMemory: true, cwd: root, agentDir: root, overrides: { "images.autoResize": false } });
	const manager = SessionManager.inMemory(root);
	const native = await nativeDraftHost(manager);
	const server = await startBroker({ stateDir: join(root, "server") });
	cleanup.push(() => server.close());
	const proxy = delayAttachReceipt ? delayedAttachReceiptProxy(server.endpoint, delayCancellationReply) : undefined;
	if (proxy) cleanup.push(() => proxy.close());
	const transport = new BrokerClient({ stateDir: join(root, "server") });
	cleanup.push(async () => { transport.close(); });
	const identity = await loadClientIdentity(join(root, "client"), { name: "Native draft fixture" });
	const client = await startClientService({ stateDir: join(root, "client"), cwd: root, identity, serverName: "Native draft fixture", connection: { kind: "loopback", endpoint: proxy?.endpoint ?? server.endpoint } });
	cleanup.push(() => client.close());
	await client.waitForConnection(AbortSignal.timeout(10_000));
	const claims: UiClaim[] = [];
	const finished = new Map<string, string | undefined>();
	const broker: Pick<BrokerApi, "openDraft" | "claimIntent" | "finishIntent"> = {
		openDraft: (...args) => transport.openDraft(...args),
		claimIntent: async (...args) => {
			const claim = await transport.claimIntent(...args);
			claims.push(claim);
			await afterClaim?.(claim);
			return claim;
		},
		finishIntent: async (id, error) => { await transport.finishIntent(id, error); finished.set(id, error); },
	};
	const bridge = new DraftBridge(broker, {
		mode: "tui", hasUI: true, agent: { kind: "main", id: "Main", name: "main", depth: 0 },
		sessionManager: manager, ui: native.ui,
	}, () => {});
	cleanup.push(async () => { bridge.close(); await bridge.settled(); await Promise.allSettled(native.nativePastes); native.controller.disposeComposerShapes(); });
	async function api(route: string, body?: unknown) {
		const response = await fetch(client.endpoint.url + route, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${client.endpoint.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
		const value: unknown = await response.json();
		return { response, value };
	}
	async function resolve(viewId = "native-view", destinationId?: string) {
		const destination = destinationId ?? await eventually(native.destinationId, id => id !== undefined);
		const result = await api("/v1/intents", { kind: "resolve", viewId, destinationId: destination });
		expect(result.response.ok).toBe(true);
		const receipt = UiIntentReceiptSchema.parse(result.value);
		const state = await eventually(async () => LocalUiStateSchema.parse((await api("/v1/state")).value), state => state.views[viewId]?.resolveIntentId === receipt.id);
		return state.views[viewId]!;
	}
	async function paste(view: ResolvedView, text: string) {
		const result = await api("/v1/intents", { kind: "paste", viewId: view.viewId, sessionId: view.sessionId, draftToken: view.draftToken, text });
		expect(result.response.ok).toBe(true);
		const receipt = UiIntentReceiptSchema.parse(result.value);
		await eventually(() => finished.has(receipt.id), Boolean);
		expect(finished.get(receipt.id)).toBeUndefined();
		return receipt;
	}
	async function attach(view: ResolvedView, paths: string[]) {
		const captured = await api("/v1/captures", { kind: "files", paths });
		expect(captured.response.ok).toBe(true);
		const capture = CaptureResultSchema.parse(captured.value);
		const result = await api("/v1/transfers", { viewId: view.viewId, captureId: capture.id, expectedSessionId: view.sessionId, expectedDraftToken: view.draftToken, expectedResolveIntentId: view.resolveIntentId });
		expect(result.response.ok).toBe(true);
		const transfer = TransferStatusSchema.parse(result.value);
		const state = await eventually(async () => LocalUiStateSchema.parse((await api("/v1/state")).value), state => ["attached", "failed", "cancelled"].includes(state.transfers.find(item => item.id === transfer.id)?.phase ?? ""));
		expect(state.transfers.find(item => item.id === transfer.id)?.phase).toBe("attached");
		const claim = claims.findLast(item => item.kind === "attach");
		expect(claim?.files?.length).toBe(paths.length);
		return claim!.files!;
	}
	return { root, manager, native, server, client, transport, bridge, api, resolve, paste, attach, claims, finished, proxy };
}

describe("OMP native directed composer boundary", () => {
	test("invisible destination metadata preserves discovery and the unsent native editor", async () => {
		const f = await fixture();
		f.native.editor.setText("already composing ");
		const view = await f.resolve();
		const node = f.native.destinationNode();
		expect(node?.p).toMatchObject({ role: "omp.client-bridge.destination", href: `omp-bridge-target://${view.destinationId}`, hidden: true });
		expect(node?.p?.actions).toBeUndefined();
		expect(f.native.above.render(100).join("\n").trim()).toBe("");
		for (const secret of [view.draftToken, f.server.endpoint.token, f.client.endpoint.token, view.sessionId]) expect(JSON.stringify(node)).not.toContain(secret);
		const receipt = await f.paste(view, "first line\n第二行\n/path-looking/plain-text");
		expect(f.native.editor.getExpandedText()).toBe("already composing first line\n第二行\n/path-looking/plain-text");
		expect(f.native.submitted()).toBe(0);
		expect(f.native.nativePastes).toEqual([]);
		await expect(f.transport.claimIntent(receipt.id, view.sessionId, view.draftToken, view.destinationId)).rejects.toThrow();
		expect(f.native.editor.getExpandedText()).toBe("already composing first line\n第二行\n/path-looking/plain-text");
		f.bridge.close();
		expect(f.native.destinationNode()).toBeUndefined();
		await eventually(async () => LocalUiStateSchema.parse((await f.api("/v1/state")).value), state => state.views[view.viewId] === undefined);
		expect((await f.api("/v1/intents", { kind: "resolve", viewId: "closed-view", destinationId: view.destinationId })).response.ok).toBe(false);
	}, 30_000);

	test("captured destinations route to the exact native composer rather than the caller's other view", async () => {
		const f = await fixture();
		const otherManager = SessionManager.inMemory(f.root);
		const other = await nativeDraftHost(otherManager);
		const bridge = new DraftBridge(f.transport, { mode: "tui", hasUI: true, agent: { kind: "main", id: "Main", name: "main", depth: 0 }, sessionManager: otherManager, ui: other.ui }, () => {});
		try {
			f.native.editor.setText("first composer ");
			other.editor.setText("second composer ");
			const first = await f.resolve();
			const otherId = await eventually(other.destinationId, id => id !== undefined);
			const second = await f.resolve("other-window", otherId);
			expect(second.sessionId).toBe(otherManager.getSessionId());
			expect(second.destinationId).not.toBe(first.destinationId);
			const result = await f.api("/v1/intents", { kind: "paste", viewId: second.viewId, sessionId: second.sessionId, draftToken: second.draftToken, text: "directed text" });
			expect(result.response.ok).toBe(true);
			await eventually(() => other.editor.getText(), text => text === "second composer directed text");
			expect(f.native.editor.getText()).toBe("first composer ");
			expect(other.submitted()).toBe(0);
			expect((await f.api("/v1/intents", { kind: "paste", viewId: second.viewId, sessionId: first.sessionId, draftToken: first.draftToken, text: "wrong destination" })).response.ok).toBe(false);
		} finally { bridge.close(); await bridge.settled(); other.controller.disposeComposerShapes(); }
	}, 30_000);

	test("submission rotates the draft on the same destination and revokes stale viewer operations", async () => {
		const f = await fixture();
		const old = await f.resolve();
		f.native.editor.handleInput("ordinary edits");
		expect(f.bridge.identity.token).toBe(old.draftToken);
		f.bridge.submitted();
		expect(f.native.destinationNode()).toBeUndefined();
		await eventually(f.native.destinationId, id => id === old.destinationId);
		expect((await f.api("/v1/intents", { kind: "paste", viewId: old.viewId, sessionId: old.sessionId, draftToken: old.draftToken, text: "stale text" })).response.ok).toBe(false);
		const current = await f.resolve();
		expect(current.destinationId).toBe(old.destinationId);
		expect(current.draftToken).not.toBe(old.draftToken);
		await f.paste(current, " new draft");
		expect(f.native.editor.getText()).toBe("ordinary edits new draft");
		expect(f.native.submitted()).toBe(0);
	}, 30_000);

	test("a late successful HTTP claim cannot paste after the native draft was submitted", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const f = await fixture(async claim => { if (claim.kind === "paste") { entered.resolve(); await release.promise; } });
		try {
			f.native.editor.setText("keep draft");
			const view = await f.resolve();
			const request = await f.api("/v1/intents", { kind: "paste", viewId: view.viewId, sessionId: view.sessionId, draftToken: view.draftToken, text: "late text" });
			expect(request.response.ok).toBe(true);
			await entered.promise;
			f.bridge.submitted();
			await eventually(f.native.destinationId, id => id === view.destinationId);
			release.resolve();
			await f.bridge.settled();
			expect(f.native.editor.getText()).toBe("keep draft");
			expect(f.native.submitted()).toBe(0);
		} finally { release.resolve(); }
	}, 30_000);

	test("broker reconnect replaces the destination and cannot complete an old native paste claim", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const f = await fixture(async claim => { if (claim.kind === "paste") { entered.resolve(); await release.promise; } });
		try {
			f.native.editor.setText("keep original draft");
			const view = await f.resolve();
			const request = await f.api("/v1/intents", { kind: "paste", viewId: view.viewId, sessionId: view.sessionId, draftToken: view.draftToken, text: "retired operation" });
			expect(request.response.ok).toBe(true);
			await entered.promise;
			await f.server.close();
			await eventually(f.native.destinationId, id => id === undefined);
			const replacement = await startBroker({ stateDir: join(f.root, "server") });
			cleanup.push(() => replacement.close());
			const current = await eventually(f.native.destinationId, id => id !== undefined && id !== view.destinationId);
			expect(current).not.toBe(view.destinationId);
			release.resolve();
			await f.bridge.settled();
			expect(f.native.editor.getText()).toBe("keep original draft");
			expect(f.native.submitted()).toBe(0);
			const receipt = UiIntentReceiptSchema.parse(request.value);
			await expect(f.transport.claimIntent(receipt.id, view.sessionId, view.draftToken, view.destinationId)).rejects.toThrow();
		} finally { release.resolve(); }
	}, 30_000);

	test.each([false, true])("verified ordinary uploads preserve native draft and existing images (%s)", async hasExistingImage => {
		const f = await fixture();
		f.native.editor.setText("existing draft ");
		if (hasExistingImage) {
			const existingPath = join(f.root, "existing.png");
			await writeFile(existingPath, png);
			await f.native.input.handleImagePathPaste(existingPath);
		}
		const original = f.native.editor.getText();
		const expanded = f.native.editor.getExpandedText();
		const images = [...f.native.editor.pendingImages];
		const links = [...f.native.editor.pendingImageLinks];
		const paths = [join(f.root, "文档 with spaces.txt"), join(f.root, "video.mp4")];
		await Promise.all(paths.map(path => writeFile(path, "fixture")));
		const files = await f.attach(await f.resolve(), paths);
		const suffix = `${files.map(file => JSON.stringify(file.path)).join(" ")}\n[Client bridge: ${INBOX_REMINDER}]\n`;
		expect(f.native.editor.getText()).toBe(original + suffix);
		expect(f.native.editor.getExpandedText()).toBe(expanded + suffix);
		expect(f.native.editor.pendingImages).toEqual(images);
		expect(f.native.editor.pendingImageLinks).toEqual(links);
		expect(f.native.nativePastes).toEqual([]);
		expect(f.native.notices).toEqual([`Client bridge: ${INBOX_REMINDER}`]);
		expect(f.native.submitted()).toBe(0);
		for (const file of files) expect(await readFile(file.path, "utf8")).toBe("fixture");
	}, 30_000);

	test.each([false, true])("uploaded PNG becomes native image content with the latest draft and ordinary inbox paths (%s)", async mixed => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const f = await fixture(async claim => { if (claim.kind === "attach") { entered.resolve(); await release.promise; } });
		try {
			f.native.editor.setText("existing draft ");
			const existingPath = join(f.root, "existing.png");
			await writeFile(existingPath, png);
			await f.native.input.handleImagePathPaste(existingPath);
			const existing = f.native.editor.pendingImages[0];
			const image = join(f.root, "image 'quoted' 名.png");
			const ordinary = join(f.root, "文档 with spaces.txt");
			await Promise.all([writeFile(image, png), writeFile(ordinary, "ordinary-file bytes\n")]);
			const attaching = f.attach(await f.resolve(), mixed ? [ordinary, image] : [image]);
			await entered.promise;
			f.native.editor.handleInput("typed during upload ");
			const latestText = f.native.editor.getText();
			const latestExpanded = f.native.editor.getExpandedText();
			release.resolve();
			const files = await attaching;
			expect(f.native.nativePastes).toHaveLength(1);
			await Promise.all(f.native.nativePastes);
			expect(f.native.statuses).toEqual([]);
			expect(f.native.submitted()).toBe(0);
			expect(f.native.editor.pendingImages).toHaveLength(2);
			expect(f.native.editor.pendingImages[0]).toBe(existing);
			expect(f.native.editor.pendingImages[1]?.mimeType).toBe("image/png");
			expect(Buffer.from(f.native.editor.pendingImages[1]!.data, "base64")).toEqual(png);
			const uploadedImage = files.at(-1)!;
			expect(imageAttachmentSource(f.native.editor.pendingImages[1]!)).toEqual({ path: uploadedImage.path, kind: "image" });
			expect(f.native.editor.pendingImageLinks).toEqual([existingPath, uploadedImage.path]);
			expect(f.native.editor.getText()).toStartWith(latestText);
			expect(f.native.editor.getExpandedText()).toStartWith(latestExpanded);
			expect(f.native.editor.getExpandedText()).toContain(formatVisionMarker("image", 2, { width: 1, height: 1 }));
			expect(f.native.editor.getText()).not.toContain(uploadedImage.path);
			if (mixed) {
				expect(f.native.editor.getText()).toContain(`${JSON.stringify(files[0]!.path)}\n[Client bridge: ${INBOX_REMINDER}]`);
				expect(await readFile(files[0]!.path, "utf8")).toBe("ordinary-file bytes\n");
				expect(f.native.notices).toEqual([`Client bridge: ${INBOX_REMINDER}`]);
			} else {
				expect(f.native.editor.getText()).not.toContain(INBOX_REMINDER);
				expect(f.native.notices).toEqual([]);
			}
		} finally { release.resolve(); }
	}, 30_000);

	test.each(["before receipt", "after cancellation", "during cleanup"] as const)("cancelling before the attach receipt retains real native completion (%s)", async finishTiming => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const f = await fixture(async claim => { if (claim.kind === "attach") { entered.resolve(); await release.promise; } }, true, finishTiming === "during cleanup");
		try {
			f.native.editor.setText("retained unsent draft ");
			const path = join(f.root, "retained.txt");
			await writeFile(path, "retained uploaded bytes");
			const view = await f.resolve();
			const capture = CaptureResultSchema.parse((await f.api("/v1/captures", { kind: "files", paths: [path] })).value);
			const transfer = TransferStatusSchema.parse((await f.api("/v1/transfers", { viewId: view.viewId, captureId: capture.id, expectedSessionId: view.sessionId, expectedDraftToken: view.draftToken, expectedResolveIntentId: view.resolveIntentId })).value);
			await Promise.all([entered.promise, f.proxy!.receipt]);
			const cancelling = f.api("/v1/transfers/cancel", { id: transfer.id });
			await f.proxy!.cancellation;
			if (finishTiming === "before receipt") { release.resolve(); await f.proxy!.finished; }
			f.proxy!.release();
			if (finishTiming === "during cleanup") {
				await f.proxy!.cancelled;
				await eventually(async () => LocalUiStateSchema.parse((await f.api("/v1/state")).value), state => state.transfers.find(item => item.id === transfer.id)?.phase === "failed");
				release.resolve();
				await f.proxy!.finished;
				await eventually(async () => LocalUiStateSchema.parse((await f.api("/v1/state")).value), state => state.transfers.find(item => item.id === transfer.id)?.phase === "attached");
				f.proxy!.releaseCancellation();
			}
			const cancellation = await cancelling;
			expect(cancellation.response.ok).toBe(false);
			expect(cancellation.value).toMatchObject({ code: "CANCEL_TOO_LATE" });
			release.resolve();
			await f.bridge.settled();
			const state = await eventually(async () => LocalUiStateSchema.parse((await f.api("/v1/state")).value), state => state.transfers.find(item => item.id === transfer.id)?.phase === "attached");
			expect(state.transfers.find(item => item.id === transfer.id)?.error).toBeUndefined();
			const uploaded = f.claims.find(item => item.kind === "attach")!.files![0]!;
			expect(f.native.editor.getText()).toContain(JSON.stringify(uploaded.path));
			expect(f.native.editor.getText()).toStartWith("retained unsent draft ");
			expect(f.native.submitted()).toBe(0);
			expect(f.proxy!.attachRequestsSeen).toBe(1);
			expect(await readFile(path, "utf8")).toBe("retained uploaded bytes");
			expect(await readFile(uploaded.path, "utf8")).toBe("retained uploaded bytes");
		} finally { release.resolve(); f.proxy!.release(); f.proxy!.releaseCancellation(); }
	}, 30_000);

	test("a pending mixed upload stays with its originating window while another composer is used", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const f = await fixture(async claim => { if (claim.kind === "attach") { entered.resolve(); await release.promise; } });
		const otherManager = SessionManager.inMemory(f.root);
		const other = await nativeDraftHost(otherManager);
		const otherBridge = new DraftBridge(f.transport, { mode: "tui", hasUI: true, agent: { kind: "main", id: "Main", name: "main", depth: 0 }, sessionManager: otherManager, ui: other.ui }, () => {});
		try {
			f.native.editor.setText("origin draft ");
			other.editor.setText("other draft ");
			const image = join(f.root, "origin.png");
			const ordinary = join(f.root, "origin.txt");
			await Promise.all([writeFile(image, png), writeFile(ordinary, "origin bytes")]);
			const attaching = f.attach(await f.resolve("origin-window"), [ordinary, image]);
			await entered.promise;
			const destinationId = await eventually(other.destinationId, id => id !== undefined);
			const view = await f.resolve("other-window", destinationId);
			expect((await f.api("/v1/intents", { kind: "paste", viewId: view.viewId, sessionId: view.sessionId, draftToken: view.draftToken, text: "independent text" })).response.ok).toBe(true);
			await eventually(() => other.editor.getText(), text => text === "other draft independent text");
			f.native.editor.handleInput("edited while pending ");
			release.resolve();
			const files = await attaching;
			await Promise.all(f.native.nativePastes);
			expect(f.native.editor.getText()).toStartWith("origin draft edited while pending ");
			expect(f.native.editor.getText()).toContain(JSON.stringify(files[0]!.path));
			expect(f.native.editor.pendingImages).toHaveLength(1);
			expect(Buffer.from(f.native.editor.pendingImages[0]!.data, "base64")).toEqual(png);
			expect(other.editor.getText()).toBe("other draft independent text");
			expect(other.editor.pendingImages).toEqual([]);
			expect(other.nativePastes).toEqual([]);
			expect(f.native.submitted()).toBe(0);
			expect(other.submitted()).toBe(0);
			expect(await readFile(files[0]!.path, "utf8")).toBe("origin bytes");
		} finally { release.resolve(); otherBridge.close(); await otherBridge.settled(); other.controller.disposeComposerShapes(); }
	}, 30_000);

	test.each(["submit", "conversation", "close"] as const)("pending mixed upload cannot follow native draft %s", async replacement => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const f = await fixture(async claim => { if (claim.kind === "attach") { entered.resolve(); await release.promise; } });
		try {
			const image = join(f.root, "pending.png");
			const ordinary = join(f.root, "pending.txt");
			await Promise.all([writeFile(image, png), writeFile(ordinary, "retained source")]);
			f.native.editor.setText("original unsent draft");
			const view = await f.resolve();
			const capture = CaptureResultSchema.parse((await f.api("/v1/captures", { kind: "files", paths: [ordinary, image] })).value);
			const transfer = TransferStatusSchema.parse((await f.api("/v1/transfers", { viewId: view.viewId, captureId: capture.id, expectedSessionId: view.sessionId, expectedDraftToken: view.draftToken, expectedResolveIntentId: view.resolveIntentId })).value);
			await entered.promise;
			if (replacement === "submit") f.bridge.submitted();
			else if (replacement === "conversation") { await f.manager.newSession(); f.native.editor.setText("replacement conversation draft"); }
			else f.bridge.close();
			const retained = f.native.editor.getText();
			release.resolve();
			await f.bridge.settled();
			const state = await eventually(async () => LocalUiStateSchema.parse((await f.api("/v1/state")).value), state => state.transfers.find(item => item.id === transfer.id)?.phase === "failed");
			expect(state.transfers.find(item => item.id === transfer.id)?.error).toBeDefined();
			expect(f.native.editor.getText()).toBe(retained);
			expect(f.native.editor.pendingImages).toEqual([]);
			expect(f.native.nativePastes).toEqual([]);
			expect(f.native.submitted()).toBe(0);
			expect(await readFile(ordinary, "utf8")).toBe("retained source");
			expect(await readFile(image)).toEqual(png);
		} finally { release.resolve(); }
	}, 30_000);
});

describe("automatic native GUI image paste", () => {
	async function automaticFixture() {
		const root = await mkdtemp(join(tmpdir(), "omp-automatic-paste-"));
		cleanup.push(() => rm(root, { recursive: true, force: true }));
		await Settings.init({ inMemory: true, cwd: root, agentDir: root, overrides: { "images.autoResize": false } });
		const native = await nativeDraftHost(SessionManager.inMemory(root), () => new NativeAttachmentEditor(getEditorTheme()));
		cleanup.push(async () => { await Promise.allSettled(native.nativePastes); native.controller.disposeComposerShapes(); });
		const image = join(root, "image with spaces.png");
		await writeFile(image, png);
		return { root, image, native };
	}

	test("direct GUI paste attaches image bytes while prose and the existing draft remain text", async () => {
		const { image, native } = await automaticFixture();
		const prose = `keep this draft\nsee ${image}\n`;
		native.editor.pasteText(prose);
		expect(native.editor.getExpandedText()).toBe(prose);
		expect(native.editor.pendingImages).toEqual([]);
		native.editor.pasteText(image);
		await Promise.all(native.nativePastes);
		expect(native.editor.pendingImages).toHaveLength(1);
		expect(Buffer.from(native.editor.pendingImages[0]!.data, "base64")).toEqual(png);
		expect(native.editor.getExpandedText()).toBe(`${prose}${formatVisionMarker("image", 1, { width: 1, height: 1 })} `);
		expect(native.submitted()).toBe(0);
	});

	test("native image replacement preserves surrounding text and ignores stale edits", async () => {
		const { image, native } = await automaticFixture();
		native.editor.setText("before SELECT after");
		native.editor.handleNativeEvent({ type: "edit", key: "input", from: 7, to: 13, text: image, cursor: 7 + image.length, len: 19 });
		await Promise.all(native.nativePastes);
		expect(native.editor.getExpandedText()).toBe(`before ${formatVisionMarker("image", 1, { width: 1, height: 1 })}  after`);
		const retained = native.editor.getExpandedText();
		native.editor.handleNativeEvent({ type: "edit", key: "input", from: 0, to: 0, text: image, cursor: image.length, len: 999 });
		await Promise.all(native.nativePastes);
		expect(native.editor.getExpandedText()).toBe(retained);
		expect(native.editor.pendingImages).toHaveLength(1);
		expect(native.submitted()).toBe(0);
	});

	test("an unreadable image falls back once without recursively converting its path", async () => {
		const { root, native } = await automaticFixture();
		const invalid = join(root, "invalid.png");
		await writeFile(invalid, "not image data");
		native.editor.setText("retained ");
		native.editor.pasteText(invalid);
		await Promise.all(native.nativePastes);
		expect(native.editor.getExpandedText()).toBe(`retained ${invalid}`);
		expect(native.editor.pendingImages).toEqual([]);
		expect(native.submitted()).toBe(0);
	});

	test("Enter waits for the real image loader rather than submitting an attachment-free draft", async () => {
		const { image, native } = await automaticFixture();
		const release = Promise.withResolvers<void>();
		const load = native.editor.onPasteImagePath!;
		native.editor.onPasteImagePath = async path => { await release.promise; await load(path); };
		const sent: Array<{ text: string; images: string[] }> = [];
		native.editor.onSubmit = text => { sent.push({ text, images: native.editor.pendingImages.map(image => image.data) }); };
		try {
			native.editor.setText("retain ");
			native.editor.pasteText(image);
			native.editor.handleInput("\r");
			expect(sent).toEqual([]);
			release.resolve();
			await eventually(() => sent.length, count => count === 1);
			expect(sent[0]!.text).toContain(formatVisionMarker("image", 1, { width: 1, height: 1 }));
			expect(sent[0]!.text).toStartWith("retain ");
			expect(sent[0]!.images).toEqual([png.toString("base64")]);
		} finally { release.resolve(); }
	});
});
