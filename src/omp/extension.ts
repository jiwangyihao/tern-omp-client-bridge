// SPDX-License-Identifier: MPL-2.0
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { findScopedSettings, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { BrokerApi, ServerState } from "../api.ts";
import { BrokerClient } from "../broker-client.ts";
import { BridgeError, type ToolName } from "../protocol.ts";
import { DraftBridge } from "./draft.ts";
import { parameters, routeTool, withTarget } from "./routing.ts";
import { nativeMetadata, type NativeMetadata } from "./native-metadata.ts";
import { BackgroundDelivery } from "./background.ts";

const TOOL_NAMES: Record<ToolName, true> = { eval: true, bash: true, read: true, write: true, edit: true, grep: true, glob: true };

export interface ExecutionIdentity {
	readonly sessionId: string;
	readonly contextId: string;
}


const MISSING_SESSION_POLICY = "Client bridge did not receive this session's scoped Settings from the native extension lifecycle. Start/reload the extension through OMP session_start/session_switch; global or same-directory sibling policies are not accepted.";

export function executionIdentity(ctx: Pick<ExtensionContext, "sessionManager" | "localProtocolOptions" | "agent">): ExecutionIdentity {
	const ownSessionId = ctx.sessionManager.getSessionId();
	// The SDK deliberately inherits the root local:// identity into task/Eval children.
	// Agent registry names alone are not globally unique and must never select a binding.
	const rootSessionId = ctx.agent.kind === "sub" ? ctx.localProtocolOptions?.getSessionId?.() : ownSessionId;
	if (!rootSessionId) throw new BridgeError("parent_identity_unavailable", "OMP did not provide this child agent's parent conversation identity");
	return { sessionId: rootSessionId, contextId: `${ownSessionId}:${ctx.agent.id}` };
}

export function bindingDescription(state: ServerState): string {
	const selected = state.devices.find(device => device.id === state.binding.clientId);
	const target = state.binding.clientId === null ? "unbound" : selected ? `${selected.name} (${selected.platform}; ${selected.online ? "online" : "offline"})` : `${state.binding.clientId} (unavailable)`;
	const change = state.binding.change;
	const actor = change ? `; changed by ${change.actor.name} from ${change.previousClientId ?? "unbound"}` : "";
	return `Client target: ${target}${actor}; revision ${state.binding.revision}. Agent host remains the default for eval/bash. Client resources use client:///absolute/path; copy complete snapshot headers verbatim, including provenance query and hash.`;
}

/** Public factory is also the DI seam for isolated SDK sessions and transport tests. */
export function installClientBridge(api: ExtensionAPI, broker: BrokerApi): void {
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
	let metadata: Record<ToolName, NativeMetadata> | undefined;
	let sessionPolicy: { sessionId: string; settings: Settings } | undefined;
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
		const oldText = lastState && bindingDescription(lastState);
		lastState = state;
		const text = bindingDescription(state);
		activeContext?.ui.setStatus("client-bridge", text);
		if (text !== oldText) {
			// Queue model context only. Never start a turn or replace the native editor.
			api.sendMessage({ customType: "client-bridge-binding", content: text, display: false }, { deliverAs: "nextTurn", triggerTurn: false });
		}
	}

	function registerOverrides(): void {
		// getAllTools is only available after runner initialization. Register on session_start,
		// retaining installed runtime's exact session-specific schemas (including disabled backends).
		for (const native of api.getAllTools()) {
			if (!Object.hasOwn(TOOL_NAMES, native.name) || registered.has(native.name) || native.sourceInfo.source !== "builtin") continue;
			const name = native.name as ToolName;
			const execution = name === "eval" || name === "bash";
			const definition: ToolDefinition = {
				...metadata![name],
				name,
				description: `${native.description}\n${execution ? 'Optional target: "agent" (default) or "client" (the manually bound device); target is fixed for the entire invocation.' : 'Explicit client:// paths and bridge-owned artifact/proc handles route to their client. Other paths retain native agent-host behavior.'}`,
				parameters: execution ? withTarget(native.parameters) : native.parameters,
				async execute(_id, input, signal, onUpdate, ctx) {
					if (sessionPolicy?.sessionId !== ctx.sessionManager.getSessionId()) throw new BridgeError("session_policy_unavailable", MISSING_SESSION_POLICY);
					const route = routeTool(name, parameters(input));
					if (!route.client) {
						if (!ctx.invokeTool) throw new BridgeError("native_delegate_unavailable", `OMP has no native ${name} delegation`);
						// Native same-name dispatch retains provider metadata, bookkeeping, signals, progress.
						return ctx.invokeTool(route.params, { signal, onUpdate });
					}
					const identity = executionIdentity(ctx);
					owned.set(identity.contextId, identity);
					// No agent cwd is copied to the client. Broker captures binding once per call.
					return broker.invoke(identity.sessionId, identity.contextId, name, route.params, { signal, onUpdate });
				},
			};
			// No custom renderer: same-name native TUI/TSP renderer dispatch stays in control.
			api.registerTool(definition);
			registered.add(name);
		}
	}

	function activate(ctx: ExtensionContext): void {
		const owner = ++activation;
		const acceptState = (state: ServerState) => { if (owner === activation) stateChanged(state); };
		if (Settings !== api.pi.Settings) {
			throw new BridgeError("host_sdk_mismatch", "Client bridge loaded a different Settings module than the active OMP host. Load this extension through OMP's native extension loader so config/settings resolves to the host SDK; refusing to use a package-local approval scope.");
		}
		activeContext = ctx;
		// The native runner wraps lifecycle handlers in withActiveSettings. Resolve once
		// HERE: outside that scope this SDK's cwd lookup merely selects the latest sibling.
		const settings = findScopedSettings(ctx.cwd);
		sessionPolicy = settings ? { sessionId: ctx.sessionManager.getSessionId(), settings } : undefined;
		if (sessionPolicy) {
			metadata ??= nativeMetadata(api, () => activeContext!, () => {
				if (!sessionPolicy || sessionPolicy.sessionId !== activeContext?.sessionManager.getSessionId()) {
					throw new BridgeError("session_policy_unavailable", MISSING_SESSION_POLICY);
				}
				return sessionPolicy.settings;
			});
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
	api.on("tool_call", (event, ctx) => {
		if (sessionPolicy?.sessionId !== ctx.sessionManager.getSessionId() && Object.hasOwn(TOOL_NAMES, event.toolName) && routeTool(event.toolName as ToolName, parameters(event.input)).client) {
			return { block: true, reason: MISSING_SESSION_POLICY };
		}
	});
	api.on("input", (event, ctx) => {
		if (event.source === "interactive" && ctx.sessionManager.getSessionId() === draft?.identity.sessionId) draft.submitted();
	});
	api.on("context", event => {
		if (!lastState) return;
		return { messages: [...event.messages, { role: "custom", customType: "client-bridge-binding", content: bindingDescription(lastState), display: false, timestamp: Date.now() }] };
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
