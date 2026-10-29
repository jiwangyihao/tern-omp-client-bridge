// SPDX-License-Identifier: MPL-2.0
import type { ExtensionUiComponentFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { NativeNode } from "@oh-my-pi/pi-tui/native/node";

export const DESTINATION_WIDGET_KEY = "client-bridge-destination";

/** Invisible public locator: Tern discovers the draft without adding an editor control. */
export function destinationWidget(destinationId: string): ExtensionUiComponentFactory {
	const rows: string[] = [];
	const node: NativeNode = {
		k: "text",
		p: {
			hidden: true,
			role: "omp.client-bridge.destination",
			href: `omp-bridge-target://${destinationId}`,
		},
	};
	return () => ({
		render: () => rows,
		invalidate() {},
		describe: () => node,
	});
}
