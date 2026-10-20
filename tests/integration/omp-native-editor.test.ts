// SPDX-License-Identifier: MPL-2.0
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { createHash } from "node:crypto";
import { StdinBuffer } from "@oh-my-pi/pi-tui/stdin-buffer";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { chipLabel, formatVisionMarker } from "@oh-my-pi/pi-tui/prompt/composer-attachments";
import { getEditorTheme, initThemeSync } from "@oh-my-pi/pi-tui/theme";
import { ExtensionUiController } from "@oh-my-pi/pi-coding-agent/modes/controllers/extension-ui-controller";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { Settings, resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { imageAttachmentSource } from "@oh-my-pi/pi-tui/prompt/image-source";
import { ControlFrameDecoder, encodeControlFrame } from "../../src/control-frame.ts";
import { DraftBridge, type DraftContext } from "../../src/omp/draft.ts";
import { INBOX_REMINDER } from "../../src/inbox-guidance.ts";
import type { UiClaim } from "../../src/api.ts";
import { UploadStore } from "../../src/uploads.ts";
import type { ExtensionUIContext, TerminalInputHandler } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";

/** Real SDK editor, without terminal/clipboard/desktop access or a model turn. */
describe("OMP18 native composer boundary", () => {
	test("consumed private control frames never enter the real unsent editor", () => {
		initThemeSync();
		const editor = new CustomEditor(getEditorTheme());
		editor.setSpellingFeatures({ typoDetection: false, autocorrect: false, autocomplete: "off" });
		const decoder = new ControlFrameDecoder();
		const intents: string[] = [];
		let submitted = false;
		editor.onSubmit = () => { submitted = true; };
		const frame = encodeControlFrame("native_intent_0001");
		for (const chunk of ["already ", frame.slice(0, 13), frame.slice(13), "composing"]) {
			const decoded = decoder.push(chunk);
			intents.push(...decoded.intentIds);
			if (decoded.text) editor.handleInput(decoded.text);
		}
		expect(editor.getText()).toBe("already composing");
		expect(intents).toEqual(["native_intent_0001"]);
		expect(submitted).toBe(false);
	});

	test("native stdin carrier preserves Escape and decodes private frames split at every UTF-8 byte", async () => {
		const claimed: string[] = [];
		const forwarded: string[] = [];
		const state = { serverInstance: "native-carrier", binding: { sessionId: "native-carrier", clientId: null, revision: 0, change: null }, devices: [] };
		const ctx: DraftContext = {
			mode: "tui", hasUI: true, agent: { kind: "main", id: "Main", name: "main", depth: 0 },
			sessionManager: { getSessionId: () => "native-carrier" },
			ui: { supportsEditor: true, onTerminalInput: () => () => {}, getEditorText: () => "", setEditorText: () => { throw new Error("Control transport must not write the draft"); }, pasteToEditor: () => { throw new Error("Control transport must not paste into the draft"); }, notify: message => { throw new Error(message); } },
		};
		const bridge = new DraftBridge({ claimIntent: async id => { claimed.push(id); return { id, kind: "resolve", state }; }, finishIntent: async () => {} }, ctx, () => {});
		const native = new StdinBuffer();
		const deliver = (input: string) => {
			const result = bridge.handleInput(input);
			if (!result?.consume) forwarded.push(result?.data ?? input);
		};
		native.on("data", deliver);
		try {
			// ProcessTerminal uses stdin.setEncoding("utf8") before StdinBuffer.
			// StringDecoder exercises that real byte boundary, including C2 | 9D.
			const utf8 = new StringDecoder("utf8");
			const frame = encodeControlFrame("native_byte_carrier_0001");
			for (const byte of Buffer.from(frame)) native.process(utf8.write(Buffer.from([byte])));
			native.process(utf8.end());
			await bridge.settled();
			expect(claimed).toEqual(["native_byte_carrier_0001"]);
			expect(forwarded.join("")).toBe("");
			forwarded.length = 0;
			native.process("\x1b");
			for (const sequence of native.flush()) deliver(sequence);
			expect(forwarded).toEqual(["\x1b"]);
			for (const sequence of ["\x1b[A", "\x1b[27u", "\x1bb"]) native.process(sequence);
			expect(forwarded).toEqual(["\x1b", "\x1b[A", "\x1b[27u", "\x1bb"]);
		} finally { native.destroy(); bridge.close(); }
	});

	test.each([false, true])("file references preserve the native draft and existing image state (%s) without submission or media paste", async hasExistingImage => {
		const directory = await mkdtemp(join(tmpdir(), "omp-native-draft-"));
		initThemeSync();
		const editor = new CustomEditor(getEditorTheme());
		editor.setSpellingFeatures({ typoDetection: false, autocorrect: false, autocomplete: "off" });
		editor.setText("existing draft ");
		const existingImage = { type: "image" as const, mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfuoAAAAASUVORK5CYII=" };
		const imageLink = "file:///synthetic/existing-user-image.png";
		const imageMarker = formatVisionMarker("image", 1, { width: 1, height: 1 });
		if (hasExistingImage) {
			// Match the native InputController's committed-image state and real atom insertion.
			// This image already belongs to the user draft; it is not transferred by the bridge.
			editor.pendingImages.push(existingImage);
			editor.pendingImageLinks.push(imageLink);
			editor.imageLinks = editor.pendingImageLinks;
			editor.insertAtom(chipLabel("image", 1), imageMarker);
		}
		const originalText = editor.getText();
		let submits = 0;
		let mediaPastes = 0;
		let listener: TerminalInputHandler | undefined;
		const outcomes: (string | undefined)[] = [];
		const notifications: string[] = [];
		editor.onSubmit = () => { submits++; };
		editor.onPasteImagePath = () => { mediaPastes++; };
		const paths = [join(directory, "文档 with spaces.txt"), join(directory, "video.mp4")];
		await Promise.all(paths.map(path => writeFile(path, "fixture")));
		const state = { serverInstance: "broker-fixture", binding: { sessionId: "native-draft", clientId: null, revision: 0, change: null }, devices: [] };
		const ctx: DraftContext = {
			mode: "tui", hasUI: true, agent: { kind: "main", id: "Main", name: "main", depth: 0 },
			sessionManager: { getSessionId: () => "native-draft" },
			ui: {
				supportsEditor: true,
				onTerminalInput: handler => { listener = handler; return () => { listener = undefined; }; },
				getEditorText: () => editor.getText(),
				setEditorText: text => editor.setText(text),
				pasteToEditor: text => editor.handleInput(`\x1b[200~${text}\x1b[201~`),
				notify: message => { notifications.push(message); },
			},
		};
		const bridge = new DraftBridge({
			claimIntent: async id => ({ id, kind: "attach", state, files: paths.map(path => ({ path, name: path, size: 7, sha256: "broker-verified" })) }),
			finishIntent: async (_id, error) => { outcomes.push(error); },
		}, ctx, () => {});
		try {
			listener?.(encodeControlFrame("native_file_ref_0001"));
			await bridge.settled();
			expect(editor.getText()).toBe(`${originalText}${paths.map(path => JSON.stringify(path)).join(" ")}\n[Client bridge: ${INBOX_REMINDER}]\n`);
			expect(outcomes).toEqual([undefined]);
			expect(notifications).toEqual([`Client bridge: ${INBOX_REMINDER}`]);
			expect(submits).toBe(0);
			expect(mediaPastes).toBe(0);
			if (hasExistingImage) {
				expect(editor.pendingImages).toEqual([existingImage]);
				expect(editor.pendingImageLinks).toEqual([imageLink]);
				expect(editor.imageLinks).toEqual([imageLink]);
				expect(editor.getExpandedText()).toBe(`existing draft ${imageMarker} ${paths.map(path => JSON.stringify(path)).join(" ")}\n[Client bridge: ${INBOX_REMINDER}]\n`);
			} else {
				expect(editor.pendingImages).toHaveLength(0);
			}
		} finally {
			bridge.close();
			await rm(directory, { recursive: true, force: true });
		}
	});

	test.each([false, true])("uploaded PNG becomes native image content, preserving draft ownership and ordinary inbox paths (%s)", async mixed => {
		const directory = await mkdtemp(join(tmpdir(), "omp-native-image-"));
		const uploads = new UploadStore(join(directory, "imports"));
		const nativePastes: Promise<void>[] = [];
		let bridge: DraftBridge | undefined;
		try {
			resetSettingsForTest();
			await Settings.init({ inMemory: true, cwd: directory, agentDir: directory, overrides: { "images.autoResize": false } });
			initThemeSync();
			const editor = new CustomEditor(getEditorTheme());
			editor.setSpellingFeatures({ typoDetection: false, autocorrect: false, autocomplete: "off" });
			const sessionManager = SessionManager.inMemory(directory);
			const uiReady = Promise.withResolvers<ExtensionUIContext>();
			const statuses: string[] = [];
			const notices: string[] = [];
			let listener: TerminalInputHandler | undefined;
			let submitted = 0;
			editor.onSubmit = () => { submitted++; };
			// Only unrelated host surfaces are absent; both paste routing and image loading
			// are the installed OMP controllers, not a callback echo or a forged pending image.
			const host = {
				editor, sessionManager, session: {}, syncComposerShape: () => {},
				setToolUIContext: (ui: ExtensionUIContext) => uiReady.resolve(ui),
				showStatus: (message: string) => { statuses.push(message); },
				ui: {
					requestRender: () => {}, getFocused: () => editor,
					addInputListener: (handler: TerminalInputHandler) => { listener = handler; return () => { listener = undefined; }; },
				},
			} as unknown as InteractiveModeContext;
			const nativeInput = new InputController(host, {
				readImage: async () => { throw new Error("Test must not read a real clipboard"); },
				readText: async () => { throw new Error("Test must not read a real clipboard"); },
				readMacFileUrls: async () => { throw new Error("Test must not read a real clipboard"); },
			});
			editor.onPasteImagePath = path => {
				const pending = nativeInput.handleImagePathPaste(path);
				nativePastes.push(pending);
				return pending;
			};
			await new ExtensionUiController(host).initHooksAndCustomTools();
			const nativeUI = await uiReady.promise;
			const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfuoAAAAASUVORK5CYII=", "base64");
			const existingPath = join(directory, "existing.png");
			await writeFile(existingPath, png);
			editor.setText("existing draft ");
			// Establish an existing attachment using the same native loader, then preserve it.
			await nativeInput.handleImagePathPaste(existingPath);
			expect(editor.pendingImages).toHaveLength(1);
			const existingImage = editor.pendingImages[0];
			const ordinaryBytes = Buffer.from("original ordinary-file bytes\n");
			const contents = mixed ? [ordinaryBytes, png] : [png];
			const names = mixed ? ["文档 with spaces.txt", "image 'quoted' 名.png"] : ["image 'quoted' 名.png"];
			const state = { serverInstance: "native-images", binding: { sessionId: sessionManager.getSessionId(), clientId: null, revision: 0, change: null }, devices: [] };
			const pendingClaim = Promise.withResolvers<UiClaim>();
			const outcomes: (string | undefined)[] = [];
			bridge = new DraftBridge({ claimIntent: () => pendingClaim.promise, finishIntent: async (_id, error) => { outcomes.push(error); } }, {
				mode: "tui", hasUI: true, agent: { kind: "main", id: "Main", name: "main", depth: 0 }, sessionManager,
				ui: { ...nativeUI, notify: message => { notices.push(message); } },
			}, () => {});
			const upload = await uploads.begin("client", { viewId: "view", sessionId: bridge.identity.sessionId, draftToken: bridge.identity.token, files: names.map((name, index) => ({ name, size: contents[index]!.length })) });
			for (const [index, bytes] of contents.entries()) await uploads.chunk("client", { id: upload.id, index, offset: 0, data: bytes.toString("base64") });
			const completed = await uploads.finish("client", upload.id, contents.map(bytes => createHash("sha256").update(bytes).digest("hex")));
			listener?.(encodeControlFrame("native_png_intent_0001"));
			editor.handleInput("typed during upload ");
			const latestText = editor.getText();
			const latestExpanded = editor.getExpandedText();
			pendingClaim.resolve({ id: "native_png_intent_0001", kind: "attach", state, files: completed.files });
			await bridge.settled();
			// The bridge settles at void native handoff, not image completion. The test alone
			// observes the real loader promise to assert the resulting attachment payload.
			expect(nativePastes).toHaveLength(1);
			await Promise.all(nativePastes);
			expect(outcomes).toEqual([undefined]);
			expect(statuses).toEqual([]);
			expect(submitted).toBe(0);
			expect(editor.pendingImages).toHaveLength(2);
			expect(editor.pendingImages[0]).toBe(existingImage);
			expect(editor.pendingImages[1]?.mimeType).toBe("image/png");
			expect(Buffer.from(editor.pendingImages[1]!.data, "base64")).toEqual(png);
			const uploadedImage = completed.files.at(-1)!;
			expect(imageAttachmentSource(editor.pendingImages[1]!)).toEqual({ path: uploadedImage.path, kind: "image" });
			expect(editor.pendingImageLinks).toEqual([existingPath, uploadedImage.path]);
			expect(editor.getText()).toStartWith(latestText);
			expect(editor.getExpandedText()).toStartWith(latestExpanded);
			expect(editor.getExpandedText()).toContain(formatVisionMarker("image", 2, { width: 1, height: 1 }));
			expect(editor.getText()).not.toContain(uploadedImage.path);
			if (mixed) {
				const ordinary = completed.files[0]!;
				expect(editor.getText()).toContain(`${JSON.stringify(ordinary.path)}\n[Client bridge: ${INBOX_REMINDER}]`);
				expect(await readFile(ordinary.path)).toEqual(ordinaryBytes);
				expect(notices).toEqual([`Client bridge: ${INBOX_REMINDER}`]);
			} else {
				expect(editor.getText()).not.toContain(INBOX_REMINDER);
				expect(notices).toEqual([]);
			}
		} finally {
			bridge?.close();
			await Promise.allSettled(nativePastes);
			await uploads.close();
			resetSettingsForTest();
			await rm(directory, { recursive: true, force: true });
		}
	});
});
