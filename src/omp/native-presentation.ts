// SPDX-License-Identifier: MPL-2.0
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { toolRenderers, type RenderResultContextOptions, type ToolRenderer } from "@oh-my-pi/pi-tui/tools";
import { VERSION } from "@oh-my-pi/pi-utils";
import { BridgeError, type ToolName } from "../protocol.ts";

const TOOL_NAMES: readonly ToolName[] = ["bash", "edit", "read", "write", "eval", "grep", "glob"];
const HOOKS = ["describeCall", "describeResult"] as const;

/** Only semantic hooks: adding ANSI hooks would change the existing terminal path. */
export type NativePresentation = Required<Pick<ToolRenderer, typeof HOOKS[number]>> & Pick<ToolRenderer, "mergeCallAndResult">;
export type NativeEditMode = InstanceType<ExtensionAPI["pi"]["EditTool"]>["mode"];

/**
 * Use the active host's public renderer registry, never a package-local copy.
 * OMP's supported extension loader rewrites these static public imports to its
 * bundled modules; a filesystem resolution path is not evidence of that binding.
 */
export function nativePresentations(api: Pick<ExtensionAPI, "pi">, editMode?: () => NativeEditMode | undefined): Record<ToolName, NativePresentation> {
	if (VERSION !== api.pi.VERSION || !toolRenderers.ask || api.pi.askToolRenderer !== toolRenderers.ask) {
		throw new BridgeError("host_renderer_mismatch", "Client bridge did not load the active OMP host's public renderer registry. Load the extension through OMP's native extension loader; refusing package-local renderer fallback.");
	}
	for (const name of TOOL_NAMES) {
		const renderer = toolRenderers[name];
		if (!renderer || HOOKS.some(hook => typeof renderer[hook] !== "function")) {
			throw new BridgeError("host_renderer_unavailable", `OMP does not expose the native TSP presentation hooks required for ${name}. Use an OMP host with public describeCall/describeResult support and reload the extension; no client bridge tool overrides were installed.`);
		}
	}
	function editOptions(options: RenderResultContextOptions): RenderResultContextOptions {
		if (options.renderContext?.editMode !== undefined) return options;
		const mode = editMode?.();
		if (mode === undefined) return options;
		// Semantic-only context: tool.mode would enable host preview waiting even
		// though this bridge does not install the resource-bearing openArgStream.
		return { ...options, renderContext: { ...options.renderContext, editMode: mode } };
	}


	const presentations = {} as Record<ToolName, NativePresentation>;
	for (const name of TOOL_NAMES) {
		const renderer = toolRenderers[name]!;
		// Keep the host's TSP merge policy without opting into its ANSI renderer path.
		// Bind to the official renderer so its receiver semantics remain intact.
		presentations[name] = {
			describeCall: name === "edit"
				? (args, options) => renderer.describeCall!(args, editOptions(options))
				: renderer.describeCall!.bind(renderer),
			describeResult: name === "edit"
				? (result, options, args) => renderer.describeResult!(result, editOptions(options), args)
				: renderer.describeResult!.bind(renderer),
			mergeCallAndResult: renderer.mergeCallAndResult,
		};
	}
	return presentations;
}
