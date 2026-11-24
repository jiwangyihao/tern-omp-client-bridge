// SPDX-License-Identifier: MPL-2.0
import { BridgeError, MAX_BOUND_CLIENTS, type BindingState, type DeviceDescriptor, type DeviceStatus, type InvocationTarget } from "./protocol.ts";

const UNBOUND: readonly string[] = Object.freeze([]);

export class SessionBindings {
	readonly #devices = new Map<string, DeviceStatus>();
	readonly #sessions = new Map<string, BindingState>();

	connect(device: DeviceDescriptor): void {
		if (!device.id || !device.name) throw new BridgeError("INVALID_DEVICE", "A client needs an identity and display name");
		this.#devices.set(device.id, Object.freeze({ ...device, online: true }));
	}

	disconnect(clientId: string): void {
		const device = this.#devices.get(clientId);
		if (device) this.#devices.set(clientId, Object.freeze({ ...device, online: false }));
	}

	devices(): readonly DeviceStatus[] {
		return [...this.#devices.values()];
	}

	state(sessionId: string): BindingState {
		if (!sessionId) throw new BridgeError("INVALID_SESSION", "An OMP session identity is required");
		let state = this.#sessions.get(sessionId);
		if (!state) {
			state = Object.freeze({ sessionId, clientIds: UNBOUND, revision: 0, change: null });
			this.#sessions.set(sessionId, state);
		}
		return state;
	}

	setMembers(sessionId: string, actorClientId: string, clientIds: readonly string[], expectedRevision: number): BindingState {
		const actor = this.#devices.get(actorClientId);
		if (!actor?.online) throw new BridgeError("ACTOR_UNAVAILABLE", "Binding changes must originate from a connected client");
		const current = this.state(sessionId);
		if (current.revision !== expectedRevision) throw new BridgeError("STALE_BINDING", "The binding changed; refresh the selector before retrying");
		if (clientIds.length > MAX_BOUND_CLIENTS) throw new BridgeError("BINDING_LIMIT", `A session can bind at most ${MAX_BOUND_CLIENTS} clients`);
		if (clientIds.length === current.clientIds.length && clientIds.every((id, i) => id === current.clientIds[i])) return current;
		const members = clientIds.length ? Object.freeze([...clientIds].sort()) : UNBOUND;
		for (let i = 0; i < members.length; i++) {
			const id = members[i]!;
			if (i > 0 && id === members[i - 1]) throw new BridgeError("INVALID_BINDING", "Duplicate client in the proposed membership");
			// Going offline does not revoke membership. Only a newly authorized member must be online.
			if (!current.clientIds.includes(id) && !this.#devices.get(id)?.online) throw new BridgeError("CLIENT_UNAVAILABLE", "The client being added is not connected");
		}
		if (members.length === current.clientIds.length && members.every((id, i) => id === current.clientIds[i])) return current;
		const revision = current.revision + 1;
		const change = Object.freeze({ revision, actor: Object.freeze({ id: actor.id, name: actor.name }), previousClientIds: current.clientIds, clientIds: members, at: new Date().toISOString() });
		const state = Object.freeze({ sessionId, clientIds: members, revision, change });
		this.#sessions.set(sessionId, state);
		return state;
	}

	capture(sessionId: string, contextId: string, requestId: string, clientId?: string): InvocationTarget {
		const state = this.state(sessionId);
		if (!state.clientIds.length) throw new BridgeError("UNBOUND", "Select a client in Tern before using a client operation");
		if (clientId === undefined && state.clientIds.length > 1) throw new BridgeError("CLIENT_ID_REQUIRED", "Multiple clients are bound; specify one bound clientId");
		const targetId = clientId ?? state.clientIds[0]!;
		if (clientId !== undefined && !state.clientIds.includes(clientId)) throw new BridgeError("CLIENT_NOT_BOUND", "The requested clientId is not bound to this session");
		const device = this.#devices.get(targetId);
		if (!device?.online) throw new BridgeError("CLIENT_OFFLINE", "The bound client is offline; the operation was not redirected");
		if (!contextId || !requestId) throw new BridgeError("INVALID_INVOCATION", "An execution context and request identity are required");
		return Object.freeze({ requestId, sessionId, contextId, bindingRevision: state.revision, device });
	}
}
