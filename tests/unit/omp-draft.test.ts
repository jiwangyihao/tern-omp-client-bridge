// SPDX-License-Identifier: MPL-2.0
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { BrokerApi, DraftDestination, DraftIntent, UiClaim } from "../../src/api.ts";
import { DraftBridge, type DraftContext } from "../../src/omp/draft.ts";
import { INBOX_REMINDER } from "../../src/inbox-guidance.ts";
import type { ExtensionWidgetContent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";

const state = { serverInstance: "broker-fixture", binding: { sessionId: "session-real", clientId: null, revision: 0, change: null }, devices: [] };
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

function fixture(claim: BrokerApi["claimIntent"], options: { acknowledge?: boolean; context?: Pick<DraftContext, "mode" | "hasUI" | "agent">; supportsEditor?: boolean } = {}) {
	let handlers: Parameters<BrokerApi["openDraft"]>[2] | undefined;
	let sessionId = "session-real";
	let destinationId = "destination-fixture";
	let text = "existing draft ";
	let widget: ExtensionWidgetContent;
	let closes = 0;
	const updates: string[] = [];
	const editorWrites: string[] = [];
	const imagePastes: string[] = [];
	const errors: string[] = [];
	const notices: string[] = [];
	const finished: { id: string; error?: string }[] = [];
	const ctx: DraftContext = {
		mode: "tui", hasUI: true, agent: { kind: "main", id: "Main", name: "main", depth: 0 },
		...options.context,
		sessionManager: { getSessionId: () => sessionId },
		ui: {
			supportsEditor: options.supportsEditor ?? true,
			setWidget: (_key, content) => { widget = content; },
			getEditorText: () => text,
			setEditorText: value => { editorWrites.push(value); text = value; },
			pasteToEditor: value => { imagePastes.push(value); },
			notify: (message, type) => { (type === "error" ? errors : notices).push(message); },
		},
	};
	const bridge = new DraftBridge({
		openDraft: (_session, _token, next) => {
			handlers = next;
			return { update: token => { updates.push(token); next.onDestination(undefined); }, close: () => { closes++; next.onDestination(undefined); } };
		},
		claimIntent: claim,
		finishIntent: async (id, error) => { finished.push({ id, error }); },
	}, ctx, () => {});
	const acknowledge = (id = destinationId, draftToken = bridge.identity.token) => {
		destinationId = id;
		const destination: DraftDestination = { id, serverInstance: state.serverInstance, draftToken };
		handlers?.onDestination(destination);
	};
	if (options.acknowledge !== false) acknowledge();
	return {
		bridge, ctx, editorWrites, imagePastes, errors, notices, finished, updates, acknowledge,
		deliver: (id: string, overrides: Partial<DraftIntent> = {}) => handlers?.onIntent({ id, sessionId, draftToken: bridge.identity.token, destinationId, ...overrides }),
		disconnect: () => handlers?.onDestination(undefined),
		type: (value: string) => { text += value; },
		replaceSession: () => { sessionId = "session-other"; },
		text: () => text, widget: () => widget, closes: () => closes, opened: () => handlers !== undefined,
	};
}

describe("native directed draft boundary", () => {
	test("publishes only after acknowledgement and claims the exact directed identity", async () => {
		const claims: string[][] = [];
		const f = fixture(async (id, sessionId, token, destinationId) => {
			claims.push([id, sessionId, token, destinationId]);
			return { id, kind: "resolve", state };
		}, { acknowledge: false });
		expect(f.widget()).toBeUndefined();
		f.deliver("before-ack");
		expect(claims).toEqual([]);
		f.acknowledge();
		expect(typeof f.widget()).toBe("function");
		f.deliver("wrong-destination", { destinationId: "other" });
		f.deliver("wrong-session", { sessionId: "other" });
		f.deliver("wrong-draft", { draftToken: "other" });
		f.deliver("directed-intent");
		await f.bridge.settled();
		expect(claims).toEqual([["directed-intent", "session-real", f.bridge.identity.token, "destination-fixture"]]);
		expect(f.editorWrites).toEqual([]);
		expect(f.finished).toEqual([{ id: "directed-intent", error: undefined }]);
		f.disconnect();
		expect(f.widget()).toBeUndefined();
		f.deliver("after-disconnect");
		f.bridge.close();
		f.acknowledge();
		f.deliver("after-close");
		expect(f.widget()).toBeUndefined();
		expect(claims).toHaveLength(1);
		expect(f.closes()).toBe(1);
	});

	test("typing preserves the draft; submission updates the same channel and waits for its acknowledgement", async () => {
		const f = fixture(async id => ({ id, kind: "bind", state }));
		const token = f.bridge.identity.token;
		f.type("still composing");
		expect(f.bridge.identity.token).toBe(token);
		f.deliver("bind-intent");
		await f.bridge.settled();
		expect(f.editorWrites).toHaveLength(0);
		f.bridge.submitted();
		expect(f.bridge.identity.token).not.toBe(token);
		expect(f.updates).toEqual([f.bridge.identity.token]);
		expect(f.closes()).toBe(0);
		expect(f.widget()).toBeUndefined();
		f.acknowledge("destination-fixture", token);
		expect(f.widget()).toBeUndefined();
		f.acknowledge();
		expect(typeof f.widget()).toBe("function");
		f.bridge.close();
	});

	test.each([
		{ mode: "rpc" as const, hasUI: true, agent: { kind: "main" as const, id: "Main", name: "main", depth: 0 } },
		{ mode: "tui" as const, hasUI: false, agent: { kind: "main" as const, id: "Main", name: "main", depth: 0 } },
		{ mode: "tui" as const, hasUI: true, agent: { kind: "sub" as const, id: "child", name: "task", depth: 1, parentId: "Main" } },
	])("noninteractive and child contexts never open or publish a draft destination (%j)", context => {
		const f = fixture(async () => { throw new Error("No draft operations allowed"); }, { context });
		expect(f.opened()).toBe(false);
		expect(f.widget()).toBeUndefined();
		f.bridge.submitted();
		expect(f.updates).toEqual([]);
		f.bridge.close();
	});

	test("native text paste does not replace or submit the editor", async () => {
		const text = "ordinary clipboard text\nincluding /path-looking/content";
		const f = fixture(async id => ({ id, kind: "paste", state, text }));
		f.deliver("paste-intent");
		await f.bridge.settled();
		expect(f.imagePastes).toEqual([text]);
		expect(f.editorWrites).toEqual([]);
		expect(f.finished).toEqual([{ id: "paste-intent", error: undefined }]);
		f.bridge.close();
	});

	test("reconnected leases cannot complete old native paste operations", async () => {
		const pending = Promise.withResolvers<UiClaim>();
		const f = fixture(() => pending.promise);
		f.deliver("late-paste");
		f.disconnect();
		f.acknowledge("replacement-destination");
		pending.resolve({ id: "late-paste", kind: "paste", state, text: "must not paste" });
		await f.bridge.settled();
		expect(f.imagePastes).toEqual([]);
		expect(f.editorWrites).toEqual([]);
		expect(f.finished[0]?.error).toContain("disconnected");
		f.bridge.close();
	});

	test("late attach claims cannot follow submission or session replacement", async () => {
		for (const replacement of ["submit", "session"] as const) {
			const pending = Promise.withResolvers<UiClaim>();
			const f = fixture(() => pending.promise);
			f.deliver("late_attach_000001");
			if (replacement === "submit") f.bridge.submitted(); else f.replaceSession();
			pending.resolve({ id: "late_attach_000001", kind: "attach", state, files: [] });
			await f.bridge.settled();
			expect(f.editorWrites).toHaveLength(0);
			expect(f.finished[0]?.error).toBeDefined();
			f.bridge.close();
		}
	});

	test("validates every staged file before preserving and extending the unsent draft", async () => {
		const dir = await mkdtemp(join(tmpdir(), "omp-draft-")); dirs.push(dir);
		const path = join(dir, "unicode 文档 with spaces.txt");
		await writeFile(path, "fixture");
		const file = { path, name: "文档.txt", size: 7, sha256: "broker-verified" };
		const f = fixture(async id => ({ id, kind: "attach", state, files: [file] }));
		f.deliver("file_attach_000001");
		await f.bridge.settled();
		expect(f.text()).toBe(`existing draft ${JSON.stringify(path)}\n[Client bridge: ${INBOX_REMINDER}]\n`);
		expect(f.notices).toEqual([`Client bridge: ${INBOX_REMINDER}`]);
		expect(f.imagePastes).toEqual([]);
		expect(f.finished[0]?.error).toBeUndefined();
		f.bridge.close();
		const missing = fixture(async id => ({ id, kind: "attach", state, files: [file, { ...file, path: join(dir, "missing.txt") }] }));
		missing.deliver("missing_attach_0001");
		await missing.bridge.settled();
		expect(missing.editorWrites).toHaveLength(0);
		expect(missing.finished[0]?.error).toBeDefined();
		missing.bridge.close();
	});

	test.each([false, true])("hands image paths to native paste once, preserving latest text in mixed batches (%s)", async mixed => {
		const dir = await mkdtemp(join(tmpdir(), "omp-image-handoff-")); dirs.push(dir);
		const image = join(dir, "image with 'quotes' and spaces.png");
		const ordinary = join(dir, "ordinary.txt");
		await Promise.all([writeFile(image, "fixture"), writeFile(ordinary, "fixture")]);
		const paths = mixed ? [ordinary, image, image] : [image, image];
		const files = paths.map(path => ({ path, name: path, size: 7, sha256: "verified" }));
		const pending = Promise.withResolvers<UiClaim>();
		const f = fixture(() => pending.promise);
		f.deliver("image_attach_00001");
		f.type("new text while uploading");
		pending.resolve({ id: "image_attach_00001", kind: "attach", state, files });
		await f.bridge.settled();
		expect(f.imagePastes).toEqual([JSON.stringify(pathToFileURL(image).href)]);
		expect(f.text()).toBe(mixed
			? `existing draft new text while uploading ${JSON.stringify(ordinary)}\n[Client bridge: ${INBOX_REMINDER}]\n`
			: "existing draft new text while uploading");
		expect(f.editorWrites).toHaveLength(mixed ? 1 : 0);
		expect(f.notices).toHaveLength(mixed ? 1 : 0);
		expect(f.finished).toEqual([{ id: "image_attach_00001", error: undefined }]);
		f.bridge.close();
	});

	test("an invalid ordinary file prevents the entire image handoff", async () => {
		const dir = await mkdtemp(join(tmpdir(), "omp-image-validation-")); dirs.push(dir);
		const image = join(dir, "image.png");
		await writeFile(image, "fixture");
		const files = [image, join(dir, "missing.txt")].map(path => ({ path, name: path, size: 7, sha256: "verified" }));
		const f = fixture(async id => ({ id, kind: "attach", state, files }));
		f.deliver("image_invalid_0001");
		await f.bridge.settled();
		expect(f.imagePastes).toEqual([]);
		expect(f.editorWrites).toEqual([]);
		expect(f.finished[0]?.error).toBeDefined();
		f.bridge.close();
	});

	test.each(["submit", "session", "close"] as const)("pending image transfer cannot follow draft %s; native paste remains untouched", async replacement => {
		const dir = await mkdtemp(join(tmpdir(), "omp-image-owner-")); dirs.push(dir);
		const path = join(dir, "image.png");
		await writeFile(path, "fixture");
		const pending = Promise.withResolvers<UiClaim>();
		const f = fixture(() => pending.promise);
		f.deliver("image_owner_00001");
		if (replacement === "submit") f.bridge.submitted();
		else if (replacement === "session") f.replaceSession();
		else f.bridge.close();
		pending.resolve({ id: "image_owner_00001", kind: "attach", state, files: [{ path, name: path, size: 7, sha256: "verified" }] });
		await f.bridge.settled();
		expect(f.imagePastes).toEqual([]);
		expect(f.editorWrites).toEqual([]);
		expect(f.finished[0]?.error).toBeDefined();
		f.bridge.close();
	});

	test("preserves text edited during upload and appends the entire validated batch once", async () => {
		const dir = await mkdtemp(join(tmpdir(), "omp-latest-draft-")); dirs.push(dir);
		const paths = [join(dir, "notes 文档.txt"), join(dir, "video.mp4")];
		await Promise.all(paths.map(path => writeFile(path, "fixture")));
		const pending = Promise.withResolvers<UiClaim>();
		const f = fixture(() => pending.promise);
		f.deliver("latest_draft_00001");
		f.type("new text while uploading");
		pending.resolve({ id: "latest_draft_00001", kind: "attach", state, files: paths.map(path => ({ path, name: path, size: 7, sha256: "verified" })) });
		await f.bridge.settled();
		expect(f.text()).toBe(`existing draft new text while uploading ${paths.map(path => JSON.stringify(path)).join(" ")}\n[Client bridge: ${INBOX_REMINDER}]\n`);
		expect(f.editorWrites).toHaveLength(1);
		expect(f.finished[0]?.error).toBeUndefined();
		f.bridge.close();
	});

	test("unsupported native image formats fail explicitly without disguising a path as an image", async () => {
		const dir = await mkdtemp(join(tmpdir(), "omp-image-format-")); dirs.push(dir);
		const path = join(dir, "drawing.svg");
		await writeFile(path, "fixture");
		const f = fixture(async id => ({ id, kind: "attach", state, files: [{ path, name: path, size: 7, sha256: "verified" }] }));
		f.deliver("image_format_00001");
		await f.bridge.settled();
		expect(f.imagePastes).toEqual([]);
		expect(f.editorWrites).toEqual([]);
		expect(f.finished[0]?.error).toContain("PNG, JPEG, GIF and WebP");
		f.bridge.close();
	});

	test("a consumed transfer cannot duplicate native image handoff", async () => {
		const dir = await mkdtemp(join(tmpdir(), "omp-image-once-")); dirs.push(dir);
		const path = join(dir, "image.png");
		await writeFile(path, "fixture");
		let claimed = false;
		const f = fixture(async id => {
			if (claimed) throw new Error("A local UI intent can be consumed only once");
			claimed = true;
			return { id, kind: "attach", state, files: [{ path, name: path, size: 7, sha256: "verified" }] };
		});
		f.deliver("image_once_000001");
		await f.bridge.settled();
		f.deliver("image_once_000001");
		await f.bridge.settled();
		expect(f.imagePastes).toEqual([JSON.stringify(pathToFileURL(path).href)]);
		expect(f.editorWrites).toEqual([]);
		expect(f.finished[0]?.error).toBeUndefined();
		expect(f.finished).toHaveLength(1);
		expect(f.errors.at(-1)).toContain("only once");
		f.bridge.close();
	});
});
