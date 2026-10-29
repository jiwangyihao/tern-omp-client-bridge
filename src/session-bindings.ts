// SPDX-License-Identifier: MPL-2.0
import { BridgeError, type BindingState, type DeviceDescriptor, type DeviceStatus, type InvocationTarget } from "./protocol.ts";

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
			state = Object.freeze({ sessionId, clientId: null, revision: 0, change: null });
			this.#sessions.set(sessionId, state);
		}
		return state;
	}

	select(sessionId: string, actorClientId: string, clientId: string | null, expectedRevision: number): BindingState {
		const actor = this.#devices.get(actorClientId);
		if (!actor?.online) throw new BridgeError("ACTOR_UNAVAILABLE", "The switch must originate from a connected client");
		const current = this.state(sessionId);
		if (current.revision !== expectedRevision) throw new BridgeError("STALE_BINDING", "The binding changed; refresh the selector before retrying");
		if (clientId !== null && !this.#devices.get(clientId)?.online) throw new BridgeError("CLIENT_UNAVAILABLE", "The selected client is not connected");
		if (current.clientId === clientId) return current;
		const revision = current.revision + 1;
		const change = Object.freeze({ revision, actor: Object.freeze({ id: actor.id, name: actor.name }), previousClientId: current.clientId, clientId, at: new Date().toISOString() });
		const state = Object.freeze({ sessionId, clientId, revision, change });
		this.#sessions.set(sessionId, state);
		return state;
	}

	capture(sessionId: string, contextId: string, requestId: string): InvocationTarget {
		const state = this.state(sessionId);
		if (state.clientId === null) throw new BridgeError("UNBOUND", "Select a client in Tern before using a client operation");
		const device = this.#devices.get(state.clientId);
		if (!device?.online) throw new BridgeError("CLIENT_OFFLINE", "The bound client is offline; the operation was not redirected");
		if (!contextId || !requestId) throw new BridgeError("INVALID_INVOCATION", "An execution context and request identity are required");
		return Object.freeze({ requestId, sessionId, contextId, bindingRevision: state.revision, device });
	}
}
