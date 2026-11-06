// SPDX-License-Identifier: MPL-2.0
import type { CustomMessagePayload } from "@oh-my-pi/pi-coding-agent/session/messages";
import { buildSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import type { ReadonlySessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ServerState } from "../api.ts";

const CUSTOM_TYPE = "client-bridge-binding";
const SOURCE = "tern-omp-client-bridge";

/** Prepare a snapshot; only the host may commit it. Never dedup against a request-local view. */
export function bindingMessage(
	manager: Pick<ReadonlySessionManager, "getBranch" | "getLeafId" | "getSessionId">,
	state: ServerState,
	content: string,
): CustomMessagePayload | undefined {
	const details = {
		source: SOURCE,
		version: 1,
		sessionId: manager.getSessionId(),
		bindingSessionId: state.binding.sessionId,
		bindingKey: JSON.stringify([state.binding.clientId, state.binding.revision, state.binding.change?.actor.id,
			state.binding.change?.previousClientId, state.binding.change?.at]),
		serverInstance: state.serverInstance,
	};
	// The host projection honors the selected branch, reset boundaries and compaction.
	// Looking through all entries would incorrectly suppress a compacted/abandoned snapshot.
	const messages = buildSessionContext(manager.getBranch(), manager.getLeafId()).messages;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		if (message.role !== "custom" || message.customType !== CUSTOM_TYPE) continue;
		const previous = message.details;
		// Legacy snapshots remain untouched. With no provenance they cannot establish
		// equivalence to this broker/session; append one owned snapshot on migration.
		if (!previous || typeof previous !== "object" || !("source" in previous) || previous.source !== SOURCE) continue;
		if ("version" in previous && previous.version === details.version
			&& "sessionId" in previous && previous.sessionId === details.sessionId
			&& "bindingSessionId" in previous && previous.bindingSessionId === details.bindingSessionId
			&& "serverInstance" in previous && previous.serverInstance === details.serverInstance
			&& "bindingKey" in previous && previous.bindingKey === details.bindingKey
			&& message.attribution === "agent" && message.content === content) return;
		break;
	}
	return { customType: CUSTOM_TYPE, content, display: false, attribution: "agent", details };
}
