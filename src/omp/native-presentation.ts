// SPDX-License-Identifier: MPL-2.0
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { VERSION } from "@oh-my-pi/pi-utils";
import { BridgeError, type ToolName } from "../protocol.ts";
import type { NativeEditMode } from "./native-presentation-18.ts";
import { reactivePresentation } from "./native-presentation-19.ts";

// Resolve the old registry only on the host that supplies it. Never evaluate
// the Bridge package's pinned TUI in a reactive host process.
const legacy = VERSION.startsWith("18.") ? await import("./native-presentation-18.ts") : undefined;

// Only the merge flag is common to both ABIs. Each host's object is spread
// into registerTool unchanged; reactive renders are not OMP 18 Components.
export function nativePresentations(api: Pick<ExtensionAPI, "pi">, editMode?: () => NativeEditMode | undefined): Record<ToolName, { mergeCallAndResult?: boolean }> {
	if (api.pi.VERSION !== VERSION) {
		throw new BridgeError("host_renderer_mismatch", "Client bridge did not load the active OMP host's SDK; refusing package-local presentation.");
	}
	if (legacy) return legacy.nativePresentations(api, editMode);
	if (VERSION !== "19.2.1" || !("askPresenter" in api.pi)) {
		throw new BridgeError("host_renderer_unavailable", `Unsupported OMP presentation API (${VERSION}); no client bridge tool overrides were installed.`);
	}
	return {
		bash: reactivePresentation("bash"), edit: reactivePresentation("edit"), read: reactivePresentation("read"),
		write: reactivePresentation("write"), eval: reactivePresentation("eval"), grep: reactivePresentation("grep"), glob: reactivePresentation("glob"),
	};
}
