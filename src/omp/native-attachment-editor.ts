// SPDX-License-Identifier: MPL-2.0
import { AsyncLocalStorage } from "node:async_hooks";
import type { PasteOptions } from "@oh-my-pi/pi-tui";
import { CustomEditor, extractImagePastePathsFromText } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { resolveTextEdit, type NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import { BRACKETED_PASTE_START, BRACKETED_PASTE_END } from "@oh-my-pi/pi-tui/stdin-buffer";

/** Native GUI pastes use pasteText directly, unlike bracketed terminal input. */
export class NativeAttachmentEditor extends CustomEditor {
	readonly #literalPaste = new AsyncLocalStorage<boolean>();
	readonly #guarded = new WeakSet<object>();

	#guard<Args extends unknown[], Result>(handler: (...args: Args) => Result): (...args: Args) => Result {
		if (this.#guarded.has(handler)) return handler;
		const guarded = (...args: Args): Result => this.#literalPaste.run(true, () => handler(...args));
		this.#guarded.add(guarded);
		return guarded;
	}

	#preparePasteHandlers(): void {
		// A loader's asynchronous text fallback must not retry the same image.
		// Async scope, rather than a global busy flag, keeps later human pastes independent.
		if (this.onPasteImagePath) this.onPasteImagePath = this.#guard(this.onPasteImagePath);
		if (this.onPasteImage) this.onPasteImage = this.#guard(this.onPasteImage);
		if (this.onPasteTextRaw) this.onPasteTextRaw = this.#guard(this.onPasteTextRaw);
	}

	override handleInput(data: string): void {
		this.#preparePasteHandlers();
		super.handleInput(data);
	}

	override pasteText(text: string, options: PasteOptions = {}): void {
		if (this.#literalPaste.getStore() || !this.onPasteImagePath || !extractImagePastePathsFromText(text)?.length) {
			super.pasteText(text, options);
			return;
		}
		this.handleInput(`${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`);
	}

	override handleNativeEvent(edit: NativeUiEvent): void {
		if (edit.type !== "edit" || !this.onPasteImagePath || !extractImagePastePathsFromText(edit.text)?.length) {
			super.handleNativeEvent(edit);
			return;
		}
		const resolved = resolveTextEdit(this.getText(), edit, text => text);
		if (!resolved) return;
		// Preserve native selection widening and caret placement before attachment loading.
		super.handleNativeEvent({ ...edit, text: "", cursor: resolved.from });
		this.pasteText(edit.text);
	}
}
