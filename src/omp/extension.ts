// SPDX-License-Identifier: MPL-2.0
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { findScopedSettings, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { BrokerApi, ServerState } from "../api.ts";
import { BrokerClient } from "../broker-client.ts";
import { BridgeError, type ToolName, type ToolResult } from "../protocol.ts";
import { DraftBridge } from "./draft.ts";
import { parameters, routeTool, withClientRouting } from "./routing.ts";
import { nativeMetadata, type NativeMetadata } from "./native-metadata.ts";
import { nativePresentations } from "./native-presentation.ts";
import { BackgroundDelivery } from "./background.ts";
import { prepareAttachmentEditor } from "./native-attachment-editor.ts";
import { bindingMessage } from "./binding-history.ts";

const TOOL_NAMES: Record<ToolName, true> = { eval: true, bash: true, read: true, write: true, edit: true, grep: true, glob: true };

export interface ExecutionIdentity {
	readonly sessionId: string;
	readonly contextId: string;
}

/**
 * OMP collapses `client://` reads into its read group and shows a grouped read's
 * image by `details.mediaPath`, opened on the agent host, outside any tool
 * presentation. A client result's path exists only on its device, so the result
 * OMP receives carries none and the returned bytes are its preview. Brokers
 * before 0.5.0-beta.12 still forward the device path.
 */
function withoutDeviceMediaPath(result: ToolResult): ToolResult {
	const details = result.details;
	if (typeof details !== "object" || details === null || !("mediaPath" in details)) return result;
	const { mediaPath: _devicePath, ...rest } = details as Record<string, unknown>;
	return { ...result, details: rest };
}

const MISSING_SESSION_POLICY = "Client bridge did not receive this session's scoped Settings from the native extension lifecycle. Start/reload the extension through OMP session_start/session_switch/session_branch; global or same-directory sibling policies are not accepted.";

export function executionIdentity(ctx: Pick<ExtensionContext, "sessionManager" | "localProtocolOptions" | "agent">): ExecutionIdentity {
	const ownSessionId = ctx.sessionManager.getSessionId();
	// The SDK deliberately inherits the root local:// identity into task/Eval children.
	// Agent registry names alone are not globally unique and must never select a binding.
	const rootSessionId = ctx.agent.kind === "sub" ? ctx.localProtocolOptions?.getSessionId?.() : ownSessionId;
	if (!rootSessionId) throw new BridgeError("parent_identity_unavailable", "OMP did not provide this child agent's parent conversation identity");
	return { sessionId: rootSessionId, contextId: `${ownSessionId}:${ctx.agent.id}` };
}

// Keep human-supplied labels on one visual line; bidi controls must not reorder a stable ID.
function quotedLabel(name: string): string {
	return JSON.stringify(name).replace(/[\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, char => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"));
}

export function bindingDescription(state: ServerState): string {
	const { clientIds } = state.binding;
	const target = clientIds.map(id => {
		const device = state.devices.find(candidate => candidate.id === id);
		return device ? `${id} (${quotedLabel(device.name)}; ${device.platform}; ${device.online ? "online" : "offline"})` : `${id} (unavailable)`;
	}).join(", ") || "unbound";
	const change = state.binding.change;
	const actor = change ? `; changed by ${quotedLabel(change.actor.name)} (${change.actor.id}) from ${change.previousClientIds.join(", ") || "unbound"}` : "";
	const selection = clientIds.length > 1 ? " Every client invocation, including handle operations, requires one explicit clientId even when only one device is online." : "";
	return `Client target: ${target}${actor}; revision ${state.binding.revision}.${selection} Agent host remains the default for eval/bash. Client resources use client:///absolute/path; copy complete snapshot headers verbatim, including provenance query and hash.`;
}

/** 19.2.1 dispatches pure tool-command lines before the replacement's execute. */
function clientBashTransport(api: ExtensionAPI, settings: () => Settings): ((command: string) => boolean) | undefined {
	if (!("servesToolCommandLine" in api.pi.BashTool.prototype)) return undefined;
	// The public enabled list includes every mounted name. Reserve its superset:
	// a false rejection is preferable to executing on the wrong machine. The
	// host classifier supplies its own shell grammar and special commands.
	const classifierSession = {
		get settings() { return settings(); },
		get toolCommands() { return { mountedNames: api.getActiveTools() }; },
		isToolActive: (name: string) => name === "bash",
	};
	const source: Partial<ToolSession> = classifierSession;
	const bash = new api.pi.BashTool(source as ToolSession);
	if (!("servesToolCommandLine" in bash) || typeof bash.servesToolCommandLine !== "function") {
		throw new BridgeError("host_dispatch_unavailable", "Cannot guard client Bash against the host tool-command dispatcher");
	}
	return bash.servesToolCommandLine.bind(bash);
}

/** Public factory is also the DI seam for isolated SDK sessions and transport tests. */
export function installClientBridge(api: ExtensionAPI, broker: BrokerApi): void {
	if (Settings !== api.pi.Settings) {
		throw new BridgeError("host_sdk_mismatch", "Client bridge loaded a different Settings module than the active OMP host. Load this extension through OMP's native extension loader so config/settings resolves to the host SDK; refusing to use a package-local approval scope.");
	}
	let metadata: Record<ToolName, NativeMetadata> | undefined;
	// Validate every public semantic renderer before registering any override.
	const presentations = nativePresentations(api, () => metadata?.edit.presentationEditMode);
	const registered = new Set<string>();
	const owned = new Map<string, ExecutionIdentity>();
	let draft: DraftBridge | undefined;
	let unwatch: (() => void) | undefined;
	let activeContext: ExtensionContext | undefined;
	let activeSessionId: string | undefined;
	let activeIdentity: ExecutionIdentity | undefined;
	let lastState: ServerState | undefined;
	const retiredInstances = new Set<string>();
	let activation = 0;
	let closed = false;
	let attachmentEditorInstalled = false;
	// Host approval belongs to this runner; client authorization belongs to one conversation.
	let runnerSettings: Settings | undefined;
	let clientPolicySessionId: string | undefined;
	const policySettings = () => {
		if (!runnerSettings) throw new BridgeError("session_policy_unavailable", MISSING_SESSION_POLICY);
		return runnerSettings;
	};
	const clientToolCommand = clientBashTransport(api, policySettings);
	const background = new BackgroundDelivery(api, () => closed ? undefined : activeIdentity, owned);

	function stateChanged(state: ServerState): void {
		if (closed || state.binding.sessionId !== activeSessionId) return;
		if (retiredInstances.has(state.serverInstance)) return;
		if (lastState) {
			if (state.serverInstance === lastState.serverInstance) {
				if (state.binding.revision < lastState.binding.revision) return;
			} else {
				// Delayed HTTP claims and queued watch events must not resurrect a
				// broker whose replacement has already reset this session's binding.
				retiredInstances.add(lastState.serverInstance);
			}
		}
		lastState = state;
		// Watch delivery updates live routing/UI state, not request-local model history.
		// The next prepared user turn snapshots it through the host's commit boundary.
		const text = bindingDescription(state);
		activeContext?.ui.setStatus("client-bridge", text);
	}

	function registerOverrides(): void {
		// getAllTools is only available after runner initialization. Register on session_start,
		// retaining installed runtime's exact session-specific schemas (including disabled backends).
		for (const native of api.getAllTools()) {
			if (!Object.hasOwn(TOOL_NAMES, native.name) || registered.has(native.name) || native.sourceInfo.source !== "builtin") continue;
			const name = native.name as ToolName;
			const execution = name === "eval" || name === "bash";
			// Keep renderer-only mode off the tool itself: mode enables preview gates.
			const { presentationEditMode: _presentationEditMode, ...executionMetadata } = metadata![name];
			const definition: ToolDefinition = {
				...executionMetadata,
				...presentations[name],
				name,
				description: `${native.description}\n${execution ? 'Optional target: "agent" (default) or "client". A clientId requires target: "client".' : 'Explicit client:// paths and bridge-owned artifact/proc handles route to their client. Do not supply clientId for agent paths.'} For client operations, pass one stable clientId from the binding snapshot, never a display name. Required with multiple bindings, even if only one is online; optional with one.`,
				parameters: withClientRouting(native.parameters, execution),
				async execute(_id, input, signal, onUpdate, ctx) {
					const route = routeTool(name, parameters(input));
					if (!route.client) {
						if (!ctx.invokeTool) throw new BridgeError("native_delegate_unavailable", `OMP has no native ${name} delegation`);
						// Native same-name dispatch retains provider metadata, bookkeeping, signals, progress.
						return ctx.invokeTool(route.params, { signal, onUpdate });
					}
					if (clientPolicySessionId !== ctx.sessionManager.getSessionId()) throw new BridgeError("session_policy_unavailable", MISSING_SESSION_POLICY);
					const identity = executionIdentity(ctx);
					owned.set(identity.contextId, identity);
					// No agent cwd is copied to the client. Broker captures binding once per call.
					const update = onUpdate && ((result: ToolResult) => onUpdate(withoutDeviceMediaPath(result)));
					return withoutDeviceMediaPath(await broker.invoke(identity.sessionId, identity.contextId, name, route.params, { signal, onUpdate: update, clientId: route.clientId }));
				},
			};
			// Tern uses the official semantic hooks; ANSI keeps its existing fallback.
			api.registerTool(definition);
			registered.add(name);
		}
	}

	function activate(ctx: ExtensionContext): void {
		if (closed) return;
		const owner = ++activation;
		const acceptState = (state: ServerState) => { if (owner === activation) stateChanged(state); };
		activeContext = ctx;
		if (!attachmentEditorInstalled && ctx.mode === "tui" && ctx.hasUI && ctx.agent.kind === "main" && ctx.ui.supportsEditor) {
			attachmentEditorInstalled = prepareAttachmentEditor(ctx.ui);
		}
		// The native runner wraps lifecycle handlers in withActiveSettings. Resolve once
		// HERE: outside that scope this SDK's cwd lookup merely selects the latest sibling.
		const settings = findScopedSettings(ctx.cwd);
		clientPolicySessionId = settings ? ctx.sessionManager.getSessionId() : undefined;
		if (settings) {
			runnerSettings = settings;
			metadata ??= nativeMetadata(api, () => activeContext!, policySettings);
			registerOverrides();
		}
		lastState = undefined;
		activeSessionId = undefined;
		activeIdentity = undefined;
		unwatch?.();
		unwatch = undefined;
		draft?.close();
		draft = new DraftBridge(broker, ctx, state => {
			// Only the current watch may establish a broker generation. An HTTP
			// claim can finish after reconnect even if its old generation was never
			// observed here; it may refine only the already-established generation.
			if (state.serverInstance === lastState?.serverInstance) acceptState(state);
		});
		try {
			const identity = executionIdentity(ctx);
			activeSessionId = identity.sessionId;
			activeIdentity = identity;
			unwatch = broker.watch(identity.sessionId, acceptState, error => {
				if (!closed && owner === activation) ctx.ui.setStatus("client-bridge", `Client bridge unavailable: ${error.message}; agent host tools remain available`);
			}, event => { if (owner === activation) background.receive(event); });
		} catch (error) {
			ctx.ui.setStatus("client-bridge", `Client bridge unavailable: ${error instanceof Error ? error.message : String(error)}; agent host tools remain available`);
		}
	}

	api.on("session_start", (_event, ctx) => activate(ctx));
	api.on("session_switch", (_event, ctx) => activate(ctx));
	api.on("session_branch", (_event, ctx) => activate(ctx));
	api.on("tool_call", (event, ctx) => {
		if (!Object.hasOwn(TOOL_NAMES, event.toolName)) return;
		const input = parameters(event.input);
		if (clientPolicySessionId !== ctx.sessionManager.getSessionId() && routeTool(event.toolName as ToolName, input).client) {
			return { block: true, reason: MISSING_SESSION_POLICY };
		}
		if (event.toolName === "bash" && input.target === "client" && typeof input.command === "string" && clientToolCommand?.(input.command)) {
			return { block: true, reason: "This Bash line is reserved for OMP host tools and cannot be dispatched to a client. Use the client-targeted tool directly or an explicit client program path." };
		}
	});
	api.on("input", (event, ctx) => {
		if (event.source === "interactive" && ctx.mode === "tui" && ctx.hasUI && ctx.agent.kind === "main"
			&& ctx.sessionManager.getSessionId() === draft?.identity.sessionId) draft.submitted();
	});
	api.on("before_agent_start", (_event, ctx) => {
		if (!lastState || closed || ctx.sessionManager.getSessionId() !== activeContext?.sessionManager.getSessionId()) return;
		if (executionIdentity(ctx).sessionId !== lastState.binding.sessionId) return;
		// This hook returns a staged custom message. The host persists it with the
		// accepted prompt; failed/cancelled preparation never advances our dedup state.
		// Do not inject into `context`: it is a per-request copy, not durable history.
		const message = bindingMessage(ctx.sessionManager, lastState, bindingDescription(lastState));
		return message ? { message } : undefined;
	});
	api.on("session_shutdown", async () => {
		closed = true;
		draft?.close();
		unwatch?.();
		activeContext?.ui.setStatus("client-bridge", undefined);
		await Promise.allSettled([...owned.values()].map(identity => broker.closeContext(identity.sessionId, identity.contextId)));
		owned.clear();
		broker.close();
	});
}

export default function clientBridgeExtension(api: ExtensionAPI): void {
	installClientBridge(api, new BrokerClient());
}
