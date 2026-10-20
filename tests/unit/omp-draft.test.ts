// SPDX-License-Identifier: MPL-2.0
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { UiClaim } from "../../src/api.ts";
import { encodeControlFrame } from "../../src/control-frame.ts";
import { DraftBridge, type DraftContext } from "../../src/omp/draft.ts";
import { INBOX_REMINDER } from "../../src/inbox-guidance.ts";
import type { TerminalInputHandler } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";

const state = { serverInstance: "broker-fixture", binding: { sessionId: "session-real", clientId: null, revision: 0, change: null }, devices: [] };
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

function fixture(claim: (id: string, sessionId: string, token: string) => Promise<UiClaim>) {
	let listener: TerminalInputHandler | undefined;
	let sessionId = "session-real";
	let text = "existing draft ";
	const editorWrites: string[] = [];
	const imagePastes: string[] = [];
	const errors: string[] = [];
	const notices: string[] = [];
	const finished: { id: string; error?: string }[] = [];
	const ctx: DraftContext = {
		mode: "tui", hasUI: true, agent: { kind: "main", id: "Main", name: "main", depth: 0 },
		sessionManager: { getSessionId: () => sessionId },
		ui: {
			supportsEditor: true,
			onTerminalInput: handler => { listener = handler; return () => { listener = undefined; }; },
			getEditorText: () => text,
			setEditorText: value => { editorWrites.push(value); text = value; },
			pasteToEditor: value => { imagePastes.push(value); },
			notify: (message, type) => { (type === "error" ? errors : notices).push(message); },
		},
	};
	const bridge = new DraftBridge({ claimIntent: claim, finishIntent: async (id, error) => { finished.push({ id, error }); } }, ctx, () => {});
	return { bridge, ctx, editorWrites, imagePastes, errors, notices, finished, input: (data: string) => listener?.(data), type: (value: string) => { text += value; }, replaceSession: () => { sessionId = "session-other"; }, text: () => text };
}

describe("native draft control boundary", () => {
	test("does not consume or defer native Escape, navigation, Alt keys, or ordinary paste", () => {
		const f = fixture(async () => { throw new Error("Ordinary input must not claim an intent"); });
		for (const input of ["\x1b", "\x1b[A", "\x1b[27u", "\x1bb", "\x1b[200~plain text\x1b[201~"]) {
			expect(f.input(input)).toBeUndefined();
		}
		expect(f.finished).toEqual([]);
		expect(f.editorWrites).toEqual([]);
		f.bridge.close();
	});

	test("consumes fragmented control frames, retaining ordinary text and real session/token", async () => {
		const claims: { sessionId: string; token: string }[] = [];
		const f = fixture(async (id, sessionId, token) => { claims.push({ sessionId, token }); return { id, kind: "resolve", state }; });
		const initial = f.bridge.identity;
		const frame = encodeControlFrame("one_time_intent_0001");
		expect(f.input(`hello${frame.slice(0, 10)}`)).toEqual({ data: "hello" });
		expect(f.input(frame.slice(10))).toEqual({ consume: true });
		await f.bridge.settled();
		expect(claims).toEqual([{ sessionId: "session-real", token: initial.token }]);
		expect(f.editorWrites).toHaveLength(0);
		expect(f.finished).toEqual([{ id: "one_time_intent_0001", error: undefined }]);
		f.bridge.close();
		expect(f.input(frame)).toBeUndefined();
	});

	test("typing does not invalidate uploads; actual submission rotates token", async () => {
		const f = fixture(async id => ({ id, kind: "bind", state }));
		const token = f.bridge.identity.token;
		f.type("still composing");
		f.input("some ordinary keystrokes");
		expect(f.bridge.identity.token).toBe(token);
		f.input(encodeControlFrame("bind_intent_000001"));
		await f.bridge.settled();
		expect(f.editorWrites).toHaveLength(0);
		f.bridge.submitted();
		expect(f.bridge.identity.token).not.toBe(token);
		f.bridge.close();
	});

	test("late attach claims cannot follow submission or session replacement", async () => {
		for (const replacement of ["submit", "session"] as const) {
			const pending = Promise.withResolvers<UiClaim>();
			const f = fixture(() => pending.promise);
			f.input(encodeControlFrame("late_attach_000001"));
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
		f.input(encodeControlFrame("file_attach_000001"));
		await f.bridge.settled();
		expect(f.text()).toBe(`existing draft ${JSON.stringify(path)}\n[Client bridge: ${INBOX_REMINDER}]\n`);
		expect(f.notices).toEqual([`Client bridge: ${INBOX_REMINDER}`]);
		expect(f.imagePastes).toEqual([]);
		expect(f.finished[0]?.error).toBeUndefined();
		f.bridge.close();
		const missing = fixture(async id => ({ id, kind: "attach", state, files: [file, { ...file, path: join(dir, "missing.txt") }] }));
		missing.input(encodeControlFrame("missing_attach_0001"));
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
		f.input(encodeControlFrame("image_attach_00001"));
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
		f.input(encodeControlFrame("image_invalid_0001"));
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
		f.input(encodeControlFrame("image_owner_00001"));
		if (replacement === "submit") f.bridge.submitted();
		else if (replacement === "session") f.replaceSession();
		else f.bridge.close();
		pending.resolve({ id: "image_owner_00001", kind: "attach", state, files: [{ path, name: path, size: 7, sha256: "verified" }] });
		await f.bridge.settled();
		expect(f.imagePastes).toEqual([]);
		expect(f.editorWrites).toEqual([]);
		expect(f.finished[0]?.error).toBeDefined();
		expect(f.input("\x1b[200~native text\x1b[201~")).toBeUndefined();
		f.bridge.close();
	});

	test("preserves text edited during upload and appends the entire validated batch once", async () => {
		const dir = await mkdtemp(join(tmpdir(), "omp-latest-draft-")); dirs.push(dir);
		const paths = [join(dir, "notes 文档.txt"), join(dir, "video.mp4")];
		await Promise.all(paths.map(path => writeFile(path, "fixture")));
		const pending = Promise.withResolvers<UiClaim>();
		const f = fixture(() => pending.promise);
		f.input(encodeControlFrame("latest_draft_00001"));
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
		f.input(encodeControlFrame("image_format_00001"));
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
		const frame = encodeControlFrame("image_once_000001");
		f.input(frame);
		await f.bridge.settled();
		f.input(frame);
		await f.bridge.settled();
		expect(f.imagePastes).toEqual([JSON.stringify(pathToFileURL(path).href)]);
		expect(f.editorWrites).toEqual([]);
		expect(f.finished[0]?.error).toBeUndefined();
		expect(f.finished[1]?.error).toContain("only once");
		f.bridge.close();
	});
});
