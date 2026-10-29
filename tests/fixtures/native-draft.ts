// SPDX-License-Identifier: MPL-2.0
import { Container } from "@oh-my-pi/pi-tui";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { getEditorTheme, initThemeSync } from "@oh-my-pi/pi-tui/theme";
import type { DescribeContext, NativeChild, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { ExtensionUiController } from "@oh-my-pi/pi-coding-agent/modes/controllers/extension-ui-controller";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

export async function eventually<T>(read: () => T | Promise<T>, accept: (value: T) => boolean): Promise<T> {
	const signal = AbortSignal.timeout(10_000);
	for (;;) {
		signal.throwIfAborted();
		const value = await read();
		if (accept(value)) return value;
		await Bun.sleep(10);
	}
}

/** Installed OMP controllers own widget construction, editor text, image loading and paste. */
export async function nativeDraftHost(sessionManager: SessionManager, createEditor: () => CustomEditor = () => new CustomEditor(getEditorTheme())) {
	initThemeSync();
	const editor = createEditor();
	editor.setSpellingFeatures({ typoDetection: false, autocorrect: false, autocomplete: "off" });
	const above = new Container();
	const below = new Container();
	const uiReady = Promise.withResolvers<ExtensionUIContext>();
	const nativePastes: Promise<void>[] = [];
	const statuses: string[] = [];
	const notices: string[] = [];
	let submitted = 0;
	editor.onSubmit = () => { submitted++; };
	const host = {
		editor, sessionManager, session: {}, syncComposerShape: () => {},
		hookWidgetContainerAbove: above, hookWidgetContainerBelow: below,
		setToolUIContext: (ui: ExtensionUIContext) => uiReady.resolve(ui),
		showStatus: (message: string) => { statuses.push(message); },
		ui: {
			requestRender: () => {}, getFocused: () => editor,
			addInputListener: () => { throw new Error("The draft bridge must not intercept native terminal input"); },
		},
	} as unknown as InteractiveModeContext;
	const input = new InputController(host, {
		readImage: async () => { throw new Error("Test must not read a real clipboard"); },
		readText: async () => { throw new Error("Test must not read a real clipboard"); },
		readMacFileUrls: async () => { throw new Error("Test must not read a real clipboard"); },
	});
	editor.onPasteImagePath = path => {
		const pending = input.handleImagePathPaste(path);
		nativePastes.push(pending);
		return pending;
	};
	const controller = new ExtensionUiController(host);
	await controller.initHooksAndCustomTools();
	const nativeUI = await uiReady.promise;
	const ui: ExtensionUIContext = { ...nativeUI, notify: message => { notices.push(message); } };
	const describeContext: DescribeContext = { cols: 100, reduceMotion: true, dark: true, supports: () => true, feature: () => true };
	function nodes(child: NativeChild): NativeNode[] {
		const node = "render" in child ? child.describe?.(describeContext) : child;
		return node ? [node, ...(node.c ?? []).flatMap(nodes)] : [];
	}
	function destinationNode() {
		return nodes(above).find(node => node.p?.role === "omp.client-bridge.destination");
	}
	function destinationId() {
		const href = destinationNode()?.p?.href;
		return href?.startsWith("omp-bridge-target://") ? href.slice("omp-bridge-target://".length) : undefined;
	}
	return { editor, input, ui, controller, nativePastes, statuses, notices, above, below, destinationNode, destinationId, submitted: () => submitted };
}
