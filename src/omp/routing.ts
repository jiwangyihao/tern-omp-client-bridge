// SPDX-License-Identifier: MPL-2.0
import type { FluentType } from "@oh-my-pi/omptype";
import type { ToolInfo } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { BridgeError, type ToolName, type ToolParameters } from "../protocol.ts";
import { isRecord } from "../json.ts";

type NativeParameters = Extract<ToolInfo["parameters"], (data: unknown) => unknown>;

function hasNativeIntersection(schema: NativeParameters): schema is NativeParameters & Pick<FluentType<unknown>, "and"> {
	return "and" in schema && typeof schema.and === "function";
}

/** Extend the installed schema, including its validators; never maintain a second Eval/Bash schema. */
export function withTarget(schema: ToolInfo["parameters"]): ToolInfo["parameters"] {
	if (typeof schema === "function") {
		// Compose through the schema's owner; a bundled host has a different type-library instance.
		if (!hasNativeIntersection(schema)) throw new BridgeError("unsupported_schema", "The native validator does not expose schema composition");
		return schema.and({ "target?": "'agent' | 'client'" });
	}
	if (schema.type !== "object" || !isRecord(schema.properties)) {
		throw new BridgeError("unsupported_schema", "The native execution tool does not expose an object parameter schema");
	}
	return { ...schema, properties: { ...schema.properties, target: { type: "string", enum: ["agent", "client"], description: "Execution host: agent (default), or the manually bound client." } } };
}

export function isBridgePath(path: string): boolean {
	const target = /^\[(.+)#[^#\]]+\]$/.exec(path)?.[1] ?? path;
	return /^client:/i.test(target) || /^(?:artifact|proc):\/\/client-/i.test(target);
}

function pathHasBridgeResource(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(pathHasBridgeResource);
	return typeof value === "string" && value.split(";").some(path => isBridgePath(path.trim()));
}

export interface ToolRoute {
	readonly client: boolean;
	readonly params: ToolParameters;
}

export function routeTool(name: ToolName, params: ToolParameters): ToolRoute {
	if (name === "eval" || name === "bash") {
		const { target, ...native } = params;
		if (target !== undefined && target !== "agent" && target !== "client") {
			throw new BridgeError("invalid_target", 'target must be "agent" or "client"');
		}
		return { client: target === "client", params: native };
	}
	let client = pathHasBridgeResource(params.path) || pathHasBridgeResource(params.paths);
	if (name === "edit" && typeof params.input === "string") {
		// Only structural path headers count. A code body containing client:// is ordinary agent data.
		for (const line of params.input.split("\n")) {
			const header = /^\[([^\r\n]+)\]\s*$/.exec(line)?.[1];
			const patchPath = /^\*\*\* (?:(?:Update|Add|Delete) File|Move to): (.+)$/.exec(line)?.[1];
			const movePath = /^MV\s+(.+)$/.exec(line)?.[1]?.replace(/^"(.*)"$/, "$1");
			if ((header && isBridgePath(header)) || (patchPath && isBridgePath(patchPath)) || (movePath && isBridgePath(movePath))) client = true;
		}
	}
	return { client, params };
}

export function parameters(value: unknown): ToolParameters {
	if (!isRecord(value)) {
		throw new BridgeError("invalid_parameters", "Tool parameters must be an object");
	}
	return value;
}
