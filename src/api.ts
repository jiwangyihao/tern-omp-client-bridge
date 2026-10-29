// SPDX-License-Identifier: MPL-2.0
import type { BindingState, DeviceDescriptor, DeviceStatus, ExecutionOptions, InvocationTarget, ToolName, ToolParameters, ToolResult } from "./protocol.ts";

export interface ServerState {
	/** Broker process identity, shared with the client's registration reply. */
	readonly serverInstance: string;
	readonly binding: BindingState;
	readonly devices: readonly DeviceStatus[];
}

export type UiIntentInput =
	| { readonly kind: "resolve"; readonly viewId: string; readonly destinationId: string }
	| { readonly kind: "bind"; readonly viewId: string; readonly sessionId: string; readonly draftToken: string; readonly clientId: string | null; readonly expectedRevision: number }
	| { readonly kind: "attach"; readonly viewId: string; readonly sessionId: string; readonly draftToken: string; readonly transferId: string }
	| { readonly kind: "paste"; readonly viewId: string; readonly sessionId: string; readonly draftToken: string; readonly text: string };

export interface UiIntentReceipt {
	readonly id: string;
	readonly expiresAt: number;
}

export interface UiIntentOutcome {
	readonly id: string;
	readonly viewId: string;
	readonly kind: UiIntentInput["kind"];
	readonly error?: string;
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
	readonly text?: string;
}

export interface ResolvedView {
	readonly viewId: string;
	readonly resolveIntentId: string;
	readonly destinationId: string;
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
	readonly error?: string;
}

export interface LocalUiState {
	readonly device: DeviceDescriptor;
	readonly connected: boolean;
	readonly serverName: string;
	readonly views: Readonly<Record<string, ResolvedView>>;
	readonly transfers: readonly TransferStatus[];
	readonly interactions: readonly InteractionRequest[];
	readonly panels: readonly PanelState[];
	readonly outcomes: readonly UiIntentOutcome[];
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

export interface DraftDestination {
	readonly id: string;
	readonly serverInstance: string;
	readonly draftToken: string;
}

export interface DraftIntent {
	readonly id: string;
	readonly destinationId: string;
	readonly sessionId: string;
	readonly draftToken: string;
}

export interface DraftChannel {
	update(draftToken: string): void;
	close(): void;
}

export interface PanelState {
	readonly owner: string;
	readonly panelId: string;
	readonly destinationId: string;
	readonly phase: "waiting" | "ready" | "closed";
}

export interface NativePanelSnapshot {
	readonly owner: string;
	readonly panelId: string;
	readonly source: string;
	readonly target: string;
	readonly agent: string;
	readonly connected: boolean;
	readonly devices: readonly { readonly name: string; readonly platform: string; readonly online: boolean; readonly bound: boolean }[];
	readonly transfers: readonly { readonly id: string; readonly name: string; readonly phase: TransferStatus["phase"]; readonly bytesSent: number; readonly totalBytes: number; readonly error?: string }[];
	readonly approvals: number;
	readonly error?: string;
}

export interface BrokerApi {
	state(sessionId: string): Promise<ServerState>;
	invoke(sessionId: string, contextId: string, tool: ToolName, params: ToolParameters, options?: ExecutionOptions): Promise<ToolResult>;
	openDraft(sessionId: string, draftToken: string, handlers: { onDestination(destination: DraftDestination | undefined): void; onIntent(intent: DraftIntent): void; onError(error: Error): void }): DraftChannel;
	claimIntent(id: string, sessionId: string, draftToken: string, destinationId: string): Promise<UiClaim>;
	finishIntent(id: string, error?: string): Promise<void>;
	watch(sessionId: string, onState: (state: ServerState) => void, onError?: (error: Error) => void, onBackgroundResult?: (event: BackgroundResult) => void): () => void;
	closeContext(sessionId: string, contextId: string): Promise<void>;
	close(): void;
}

export interface OwnedResource {
	readonly target: InvocationTarget;
	readonly path: string;
}
