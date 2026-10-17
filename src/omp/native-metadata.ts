// SPDX-License-Identifier: MPL-2.0
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { ToolName } from "../protocol.ts";

export interface NativeMetadata extends Pick<ToolDefinition, "approval" | "label" | "loadMode" | "strict" | "readsSkillUris"> {
	readonly concurrency?: "shared" | "exclusive" | ((params: Record<string, unknown>) => "shared" | "exclusive");
	readonly formatApprovalDetails?: (args: unknown) => string[];
	readonly customFormat?: { syntax: "lark"; definition: string };
	readonly customWireName?: string;
}

export interface MetadataContext extends Pick<ExtensionContext, "cwd" | "hasUI" | "localProtocolOptions" | "model"> {
	readonly sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId" | "getSessionFile">;
}

/**
 * SDK18.10.4 metadata constructors do not execute tools. Keep their policy functions,
 * rather than copying Bash pattern rules or replacing dynamic URI tiers with "exec".
 * The created tools are deliberately never exposed as execution implementations.
 */
export function nativeMetadata(api: Pick<ExtensionAPI, "pi">, context: () => MetadataContext, settings: Settings | (() => Settings)): Record<ToolName, NativeMetadata> {
	const source: Partial<ToolSession> = {
		get cwd() { return context().cwd; },
		get hasUI() { return context().hasUI; },
		get settings() { return typeof settings === "function" ? settings() : settings; },
		get localProtocolOptions() { return context().localProtocolOptions; },
		getSessionFile: () => context().sessionManager.getSessionFile() ?? null,
		getSessionId: () => context().sessionManager.getSessionId(),
		getActiveModel: () => context().model,
	};
	// Constructor/approval-only slice: these installed constructors and policy functions
	// do not call getSessionSpawns or execute. Unavailable execution state is not invented.
	const session = source as ToolSession;
	const tools = {
		eval: new api.pi.EvalTool(session),
		bash: new api.pi.BashTool(session),
		read: new api.pi.ReadTool(session),
		write: new api.pi.WriteTool(session),
		edit: new api.pi.EditTool(session),
		grep: new api.pi.GrepTool(session),
		glob: new api.pi.GlobTool(session),
	};
	const result = {} as Record<ToolName, NativeMetadata>;
	for (const name of Object.keys(tools) as ToolName[]) {
		const tool = tools[name];
		result[name] = {
			label: tool.label,
			loadMode: tool.loadMode,
			strict: tool.strict,
			approval: tool.approval,
			...("concurrency" in tool ? { concurrency: tool.concurrency } : {}),
			...("readsSkillUris" in tool ? { readsSkillUris: tool.readsSkillUris } : {}),
			...("formatApprovalDetails" in tool ? { formatApprovalDetails: tool.formatApprovalDetails } : {}),
			...("customFormat" in tool ? { customFormat: tool.customFormat, customWireName: tool.customWireName } : {}),
		};
	}
	return result;
}
