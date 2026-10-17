// SPDX-License-Identifier: MPL-2.0
import type { BindingState, DeviceDescriptor, DeviceStatus, ExecutionOptions, InvocationTarget, ToolName, ToolParameters, ToolResult } from "./protocol.ts";

export interface ServerState {
	/** Broker process identity, shared with the client's registration reply. */
	readonly serverInstance: string;
	readonly binding: BindingState;
	readonly devices: readonly DeviceStatus[];
}

export type UiIntentInput =
	| { readonly kind: "resolve"; readonly viewId: string }
	| { readonly kind: "bind"; readonly viewId: string; readonly sessionId: string; readonly clientId: string | null; readonly expectedRevision: number }
	| { readonly kind: "attach"; readonly viewId: string; readonly sessionId: string; readonly draftToken: string; readonly transferId: string };

export interface UiIntentReceipt {
	readonly id: string;
	readonly frame: string;
	readonly expiresAt: number;
}

export interface ImportedFile {
	readonly name: string;
	readonly path: string;
	readonly size: number;
	readonly sha256: string;
}

export interface UiClaim {
	readonly id: string;
	readonly kind: UiIntentInput["kind"];
	readonly state: ServerState;
	readonly files?: readonly ImportedFile[];
}

export interface ResolvedView {
	readonly viewId: string;
	readonly resolveIntentId: string;
	readonly sessionId: string;
	readonly draftToken: string;
	readonly state: ServerState;
}

export interface InteractionRequest {
	readonly id: string;
	readonly contextId: string;
	readonly title: string;
	readonly message: string;
	readonly choices: readonly { readonly id: string; readonly label: string }[];
}

export interface InteractionDecision {
	readonly choice: string | null;
}

export interface TransferStatus {
	readonly id: string;
	readonly viewId: string;
	readonly source: DeviceDescriptor;
	readonly phase: "captured" | "uploading" | "ready" | "attached" | "failed" | "cancelled";
	readonly bytesSent: number;
	readonly totalBytes: number;
	readonly names: readonly string[];
	readonly frame?: string;
	readonly error?: string;
}

export interface LocalUiState {
	readonly device: DeviceDescriptor;
	readonly connected: boolean;
	readonly serverName: string;
	readonly views: Readonly<Record<string, ResolvedView>>;
	readonly transfers: readonly TransferStatus[];
	readonly interactions: readonly InteractionRequest[];
}

export interface CaptureResult {
	readonly id: string;
	readonly kind: "files";
	readonly names: readonly string[];
}

export interface BackgroundResult {
	readonly target: InvocationTarget;
	readonly result: ToolResult;
}

export interface BrokerApi {
	state(sessionId: string): Promise<ServerState>;
	invoke(sessionId: string, contextId: string, tool: ToolName, params: ToolParameters, options?: ExecutionOptions): Promise<ToolResult>;
	claimIntent(id: string, sessionId: string, draftToken: string): Promise<UiClaim>;
	finishIntent(id: string, error?: string): Promise<void>;
	watch(sessionId: string, onState: (state: ServerState) => void, onError?: (error: Error) => void, onBackgroundResult?: (event: BackgroundResult) => void): () => void;
	closeContext(sessionId: string, contextId: string): Promise<void>;
	close(): void;
}

export interface OwnedResource {
	readonly target: InvocationTarget;
	readonly path: string;
}
