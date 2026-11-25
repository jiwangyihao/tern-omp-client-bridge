// SPDX-License-Identifier: MPL-2.0
import type { ToolApprovalDecision } from "@oh-my-pi/pi-agent-core";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { resolveApprovalFromContext, type ApprovalContextSource } from "@oh-my-pi/pi-coding-agent/tools/approval";
import { isRecord } from "../json.ts";
import { routeTool } from "./routing.ts";
import type { ToolName } from "../protocol.ts";

export interface NativeMetadata extends Pick<ToolDefinition, "approval" | "label" | "loadMode" | "strict" | "readsSkillUris"> {
	readonly concurrency?: "shared" | "exclusive" | ((params: Record<string, unknown>) => "shared" | "exclusive");
	readonly formatApprovalDetails?: (args: unknown) => string[];
	readonly approvalCacheTargets?: (args: unknown) => readonly string[] | undefined;
	/** Renderer-only metadata; never expose this as the registered tool's mode. */
	readonly presentationEditMode?: InstanceType<ExtensionAPI["pi"]["EditTool"]>["mode"];
}

export interface MetadataContext extends Pick<ExtensionContext, "cwd" | "hasUI" | "localProtocolOptions" | "model"> {
	readonly sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId" | "getSessionFile">;
}

type TargetPolicy = Required<Pick<NativeMetadata, "approvalCacheTargets">>;

function hasTargetPolicy(tool: object): tool is TargetPolicy {
	return "approvalCacheTargets" in tool && typeof tool.approvalCacheTargets === "function";
}

/** 19's file grants identify agent-host paths, not a file on the bound device. */
function filePolicy(name: ToolName, tool: TargetPolicy & { approval: (args: unknown, context?: ApprovalContextSource) => ToolApprovalDecision }, session: ToolSession) {
	const client = (args: unknown) => isRecord(args) && routeTool(name, args).client;
	return {
		approvalCacheTargets: (args: unknown) => client(args) ? undefined : tool.approvalCacheTargets(args),
		approval(args: unknown, context?: ApprovalContextSource): ToolApprovalDecision {
			const decision = tool.approval(args, context);
			if (!client(args) || (typeof decision === "object" && (decision.policy || decision.override))) return decision;
			const { approvalMode, userPolicies } = resolveApprovalFromContext(context ?? { settings: session.settings });
			// The installed 18 types predate this mode. A 19 cached-mode read without
			// targets is automatically allowed; require this one call instead. Native
			// tool/user decisions still win, and the device enforces its own policy.
			const mode: string = approvalMode;
			const userPolicy = userPolicies[name];
			if (mode !== "always-ask-cached" || (typeof userPolicy === "string" && /^(?:allow|deny|prompt)$/i.test(userPolicy))) return decision;
			return { tier: typeof decision === "string" ? decision : decision.tier, policy: "prompt", reason: "Client files are not covered by agent-host file or folder grants." };
		},
	};
}

/**
 * The native metadata constructors do not execute tools. Keep their policy functions,
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
			...(hasTargetPolicy(tool) && typeof tool.approval === "function" ? filePolicy(name, { approval: tool.approval, approvalCacheTargets: tool.approvalCacheTargets }, session) : {}),
			...("concurrency" in tool ? { concurrency: tool.concurrency } : {}),
			...("readsSkillUris" in tool ? { readsSkillUris: tool.readsSkillUris } : {}),
			...("formatApprovalDetails" in tool ? { formatApprovalDetails: tool.formatApprovalDetails } : {}),
		};
	}
	result.edit = { ...result.edit, get presentationEditMode() { return tools.edit.mode; } };
	return result;
}
