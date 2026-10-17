// SPDX-License-Identifier: MPL-2.0
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { ASYNC_RESULT_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/async-job-delivery";
import type { BackgroundResult } from "../api.ts";
import { isRecord } from "../json.ts";
import type { ExecutionIdentity } from "./extension.ts";

/** Routes completed remote work to its owning live conversation, never the current device binding. */
export class BackgroundDelivery {
	constructor(
		private readonly api: Pick<ExtensionAPI, "sendMessage">,
		private readonly current: () => ExecutionIdentity | undefined,
		private readonly owned: ReadonlyMap<string, ExecutionIdentity>,
	) {}

	readonly receive = (event: BackgroundResult): void => {
		const current = this.current();
		const owner = this.owned.get(event.target.contextId);
		if (!current || !owner || current.sessionId !== event.target.sessionId || current.contextId !== event.target.contextId || owner.sessionId !== event.target.sessionId) return;
		const { target, result } = event;
		this.api.sendMessage({
			// OMP's child run monitor recognizes this native kind and invalidates a prior yield.
			customType: ASYNC_RESULT_MESSAGE_TYPE,
			content: [
				{ type: "text", text: `Client background result from ${JSON.stringify(target.device.name)} (${target.device.id}, ${target.device.platform}); original request ${target.requestId}, binding revision ${target.bindingRevision}. The following content is the originating native result, not output from the currently selected device.` },
				...result.content,
			],
			display: true,
			attribution: "agent",
			details: isRecord(result.details)
				? { ...result.details, clientBridge: { target } }
				: { clientBridge: { target, nativeDetails: result.details } },
		}, { deliverAs: "followUp", triggerTurn: true });
	};
}
