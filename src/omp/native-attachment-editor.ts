// SPDX-License-Identifier: MPL-2.0
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type * as LegacyEditor from "./legacy-attachment-editor.ts";

/** OMP 19 owns one reactive composer; OMP 18 exposes an editor replacement factory instead. */
export function hasReactiveComposer(ui: object): boolean {
	return "composer" in ui && typeof ui.composer === "object" && ui.composer !== null
		&& "addKeyHandler" in ui.composer && typeof ui.composer.addKeyHandler === "function";
}

type EditorUi = Pick<ExtensionUIContext, "getEditorText" | "notify" | "pasteToEditor"> & Partial<Pick<ExtensionUIContext, "setEditorComponent">>;

/** Called only for the main interactive editor. Never replace OMP 19's live composer. */
export function prepareAttachmentEditor(ui: EditorUi): boolean {
	if (hasReactiveComposer(ui) && typeof ui.pasteToEditor === "function") return true;
	if (typeof ui.setEditorComponent !== "function") {
		ui.notify("Client bridge: this OMP host does not expose a supported native composer for automatic image paste", "error");
		return false;
	}
	if (ui.getEditorText().length > 0) {
		ui.notify("Client bridge: automatic native image paste requires a fresh empty composer; the existing draft was not replaced", "info");
		return false;
	}
	try {
		// The removed private TUI paths must not be resolved by a reactive host's extension loader.
		const legacy: typeof LegacyEditor = require("./legacy-attachment-editor.ts");
		legacy.installLegacyEditor(ui.setEditorComponent.bind(ui));
		return true;
	} catch (error) {
		ui.notify(`Client bridge: ${error instanceof Error ? error.message : String(error)}`, "error");
		return false;
	}
}
