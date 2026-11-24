// SPDX-License-Identifier: MPL-2.0
import type { FluentType } from "@oh-my-pi/omptype";
import type { ToolInfo } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { BridgeError, type ToolName, type ToolParameters } from "../protocol.ts";
import { isRecord } from "../json.ts";

type NativeParameters = Extract<ToolInfo["parameters"], (data: unknown) => unknown>;

function hasNativeIntersection(schema: NativeParameters): schema is NativeParameters & Pick<FluentType<unknown>, "and"> {
	return "and" in schema && typeof schema.and === "function";
}

const CLIENT_ID = /^[A-Za-z0-9_-]{1,256}$/;

/** Extend through the installed schema owner, retaining each native tool's validation. */
export function withClientRouting(schema: ToolInfo["parameters"], execution: boolean): ToolInfo["parameters"] {
	if (typeof schema === "function") {
		// Compose through the schema's owner; a bundled host has a different type-library instance.
		if (!hasNativeIntersection(schema)) throw new BridgeError("unsupported_schema", "The native validator does not expose schema composition");
		return schema.and(execution ? { "clientId?": CLIENT_ID, "target?": "'agent' | 'client'" } : { "clientId?": CLIENT_ID });
	}
	if (schema.type !== "object" || !isRecord(schema.properties)) {
		throw new BridgeError("unsupported_schema", "The native tool does not expose an object parameter schema");
	}
	return { ...schema, properties: { ...schema.properties, clientId: { type: "string", pattern: CLIENT_ID.source },
		...(execution ? { target: { type: "string", enum: ["agent", "client"] } } : {}) } };
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
	readonly clientId?: string;
	readonly params: ToolParameters;
}

export function routeTool(name: ToolName, params: ToolParameters): ToolRoute {
	const execution = name === "eval" || name === "bash";
	if (execution && !Object.hasOwn(params, "target") && !Object.hasOwn(params, "clientId")) return { client: false, params };
	if (execution) {
		const { target, clientId, ...native } = params;
		if (target !== undefined && target !== "agent" && target !== "client") {
			throw new BridgeError("invalid_target", 'target must be "agent" or "client"');
		}
		return selectedRoute(target === "client", native, clientId);
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
	if (!Object.hasOwn(params, "clientId")) return { client, params };
	const { clientId, ...native } = params;
	return selectedRoute(client, native, clientId);
}

function selectedRoute(client: boolean, params: ToolParameters, clientId: unknown): ToolRoute {
	if (clientId === undefined) return { client, params };
	if (!client) throw new BridgeError("invalid_target", 'clientId requires target: "client" for eval/bash or a Bridge path/handle for file tools');
	if (typeof clientId !== "string" || !CLIENT_ID.test(clientId)) throw new BridgeError("invalid_client_id", "clientId must be a stable device ID from the binding snapshot");
	return { client, params, clientId };
}

export function parameters(value: unknown): ToolParameters {
	if (!isRecord(value)) {
		throw new BridgeError("invalid_parameters", "Tool parameters must be an object");
	}
	return value;
}
