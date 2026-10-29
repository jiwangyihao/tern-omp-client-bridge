// SPDX-License-Identifier: MPL-2.0
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";

export const PROTOCOL_VERSION = 2;
export type Platform = "darwin" | "win32" | "linux";
export type ToolName = "read" | "write" | "edit" | "grep" | "glob" | "bash" | "eval";
export type ToolParameters = Record<string, unknown>;
export type ToolResult = AgentToolResult<unknown>;

export interface DeviceDescriptor {
	readonly id: string;
	readonly name: string;
	readonly platform: Platform;
	readonly arch: string;
}

export interface DeviceStatus extends DeviceDescriptor {
	readonly online: boolean;
}

export interface SwitchActor {
	readonly id: string;
	readonly name: string;
}

export interface BindingChange {
	readonly revision: number;
	readonly actor: SwitchActor;
	readonly previousClientId: string | null;
	readonly clientId: string | null;
	readonly at: string;
}

export interface BindingState {
	readonly sessionId: string;
	readonly clientId: string | null;
	readonly revision: number;
	readonly change: BindingChange | null;
}

export interface InvocationTarget {
	readonly requestId: string;
	readonly sessionId: string;
	readonly contextId: string;
	readonly bindingRevision: number;
	readonly device: DeviceDescriptor;
}

export interface ExecuteRequest {
	readonly target: InvocationTarget;
	readonly tool: ToolName;
	readonly params: ToolParameters;
}

export interface ExecutionOptions {
	readonly signal?: AbortSignal;
	readonly onUpdate?: (result: ToolResult) => void;
	readonly onBackgroundResult?: (result: ToolResult) => void;
}

export interface Executor {
	execute(request: ExecuteRequest, options?: ExecutionOptions): Promise<ToolResult>;
	disposeContext(contextId: string): Promise<void>;
	close(): Promise<void>;
}

export interface BridgeFailure {
	readonly code: string;
	readonly message: string;
}

export class BridgeError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
		this.name = "BridgeError";
	}
}
