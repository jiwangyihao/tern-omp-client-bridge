// SPDX-License-Identifier: MPL-2.0
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import * as hostTui from "@oh-my-pi/pi-tui";
import type { NativeNode } from "@oh-my-pi/pi-tui/native/node";

const DESTINATION_WIDGET_KEY = "client-bridge-destination";
const aboveEditor = { placement: "aboveEditor" } as const;

type WidgetHost = (Pick<ExtensionUIContext, "setWidget"> & { readonly composer?: undefined }) | {
	readonly composer: object;
	setWidget(key: string, content: (() => unknown) | undefined, options: typeof aboveEditor): void;
};

/** Invisible public locator: Tern discovers the draft without adding an editor control. */
export function setDestinationWidget(ui: WidgetHost, destinationId: string | undefined): void {
	if (destinationId === undefined) {
		ui.setWidget(DESTINATION_WIDGET_KEY, undefined, aboveEditor);
		return;
	}
	const props = { hidden: true, role: "omp.client-bridge.destination", href: `omp-bridge-target://${destinationId}` };
	if (ui.composer) {
		// 19 turns { render(width) } into an opaque canvas. A real host UiNode retains
		// the role and href in Tern's dock tree even when the text node is hidden.
		ui.setWidget(DESTINATION_WIDGET_KEY, () => {
			const jsx: unknown = Reflect.get(hostTui, "jsx");
			if (typeof jsx !== "function") throw new Error("Client bridge: OMP's reactive widget factory is unavailable");
			return jsx("text", props);
		}, aboveEditor);
	} else {
		const node: NativeNode = { k: "text", p: props };
		const rows: string[] = [];
		ui.setWidget(DESTINATION_WIDGET_KEY, () => ({
			render: () => rows,
			invalidate() {},
			describe: () => node,
		}), aboveEditor);
	}
}
