// SPDX-License-Identifier: MPL-2.0
import { expect, test } from "bun:test";
import { ControlFrameDecoder, encodeControlFrame } from "../../src/control-frame.ts";

test("control frames split across reads are consumed without losing ordinary editor input", () => {
	const decoder = new ControlFrameDecoder();
	const id = "intent_0123456789abcdef";
	const frame = encodeControlFrame(id);
	const first = decoder.push("draft " + frame.slice(0, 9));
	const second = decoder.push(frame.slice(9) + "继续输入");
	expect(first.text + second.text + decoder.flush()).toBe("draft 继续输入");
	expect([...first.intentIds, ...second.intentIds]).toEqual([id]);
});

test("private frames avoid native shortcut bytes and survive character-by-character delivery", () => {
	const id = "native_character_delivery_0001";
	const frame = encodeControlFrame(id);
	// Native GUI shortcuts consume C0 keys before extension input listeners.
	expect(frame).not.toMatch(/[\x00-\x1f\x7f]/);
	const decoder = new ControlFrameDecoder();
	const intents: string[] = [];
	for (const character of frame) {
		const decoded = decoder.push(character);
		expect(decoded.text).toBe("");
		intents.push(...decoded.intentIds);
	}
	expect(intents).toEqual([id]);
	expect(decoder.flush()).toBe("");
});

test("ordinary bracketed paste and malformed control sequences remain user input", () => {
	const decoder = new ControlFrameDecoder();
	const text = "\x1b[200~/tmp/图片.png\x1b[201~\x1b]777;tern-omp-client-bridge;bad\x07";
	const result = decoder.push(text);
	expect(result.text + decoder.flush()).toBe(text);
	expect(result.intentIds).toEqual([]);
});

test("standalone Escape and native escape sequences pass through immediately", () => {
	const decoder = new ControlFrameDecoder();
	for (const key of ["\x1b", "\x1b[A", "\x1b[1;5D", "\x1b[27u", "\x1bb", "\x1b]", "\x1b[200~plain text\x1b[201~"]) {
		expect(decoder.push(key)).toEqual({ text: key, intentIds: [] });
		expect(decoder.flush()).toBe("");
	}
});

test("every private frame split preserves surrounding input and claims exactly once", () => {
	const id = "all_splits_0123456789";
	const frame = encodeControlFrame(id);
	for (let split = 1; split < frame.length; split++) {
		const decoder = new ControlFrameDecoder();
		const first = decoder.push("before" + frame.slice(0, split));
		const second = decoder.push(frame.slice(split) + "after\x1b");
		expect(first.text + second.text).toBe("beforeafter\x1b");
		expect([...first.intentIds, ...second.intentIds]).toEqual([id]);
		expect(decoder.flush()).toBe("");
	}
});

test("malformed and abandoned private fragments are recoverable without losing bytes", () => {
	const frame = encodeControlFrame("malformed_0123456789");
	for (const input of [frame.slice(0, 4), frame.replace("malformed_0123456789", "bad!"), frame.replace("malformed_0123456789", "x".repeat(129)), frame.slice(0, 5) + "other text"]) {
		const decoder = new ControlFrameDecoder();
		let text = "";
		for (const character of input) {
			const result = decoder.push(character);
			text += result.text;
			expect(result.intentIds).toEqual([]);
		}
		expect(text + decoder.flush()).toBe(input);
	}
});
