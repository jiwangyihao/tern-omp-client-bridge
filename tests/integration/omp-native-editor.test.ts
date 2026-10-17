// SPDX-License-Identifier: MPL-2.0
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { StdinBuffer } from "@oh-my-pi/pi-tui/stdin-buffer";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { chipLabel, formatVisionMarker } from "@oh-my-pi/pi-tui/prompt/composer-attachments";
import { getEditorTheme, initThemeSync } from "@oh-my-pi/pi-tui/theme";
import { ControlFrameDecoder, encodeControlFrame } from "../../src/control-frame.ts";
import { DraftBridge, type DraftContext } from "../../src/omp/draft.ts";
import type { TerminalInputHandler } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";

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
			ui: { supportsEditor: true, onTerminalInput: () => () => {}, getEditorText: () => "", setEditorText: () => { throw new Error("Control transport must not write the draft"); }, notify: message => { throw new Error(message); } },
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
			expect(editor.getText()).toBe(`${originalText}${paths.map(path => JSON.stringify(path)).join(" ")} `);
			expect(outcomes).toEqual([undefined]);
			expect(notifications).toEqual([]);
			expect(submits).toBe(0);
			expect(mediaPastes).toBe(0);
			if (hasExistingImage) {
				expect(editor.pendingImages).toEqual([existingImage]);
				expect(editor.pendingImageLinks).toEqual([imageLink]);
				expect(editor.imageLinks).toEqual([imageLink]);
				expect(editor.getExpandedText()).toBe(`existing draft ${imageMarker} ${paths.map(path => JSON.stringify(path)).join(" ")} `);
			} else {
				expect(editor.pendingImages).toHaveLength(0);
			}
		} finally {
			bridge.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
});
