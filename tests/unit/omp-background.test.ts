// SPDX-License-Identifier: MPL-2.0
import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { CustomMessagePayload } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { BackgroundResult } from "../../src/api.ts";
import { BackgroundDelivery } from "../../src/omp/background.ts";
import type { ExecutionIdentity } from "../../src/omp/extension.ts";

type StructuredMessage = Exclude<CustomMessagePayload, string>;

function structuredMessage(message: CustomMessagePayload): StructuredMessage {
	if (typeof message === "string") throw new Error("Expected a structured native background message");
	return message;
}

class BackgroundEvent extends Event {
	constructor(readonly result: BackgroundResult) { super("background"); }
}

function result(contextId = "omp-main:Main", sessionId = "root", deviceId = "original-device"): BackgroundResult {
	return {
		target: { requestId: "request-1", sessionId, contextId, bindingRevision: 3, device: { id: deviceId, name: deviceId, platform: "darwin", arch: "arm64", capabilities: ["exec"] } },
		result: { content: [{ type: "text", text: "native process exited with status 7\nartifact://client-result" }], details: { exitCode: 7, jobId: "native-job-1" } },
	};
}

describe("owning OMP context background follow-ups", () => {
	test("delivers an owned completion as an agent-attributed native follow-up", async () => {
		const owner: ExecutionIdentity = { sessionId: "root", contextId: "omp-main:Main" };
		const received = Promise.withResolvers<StructuredMessage>();
		const sent: StructuredMessage[] = [];
		const api: Pick<ExtensionAPI, "sendMessage"> = {
			sendMessage(message, options) {
				expect(options).toEqual({ deliverAs: "followUp", triggerTurn: true });
				const structured = structuredMessage(message);
				sent.push(structured);
				received.resolve(structured);
			},
		};
		const delivery = new BackgroundDelivery(api, () => owner, new Map([[owner.contextId, owner]]));
		const events = new EventTarget();
		events.addEventListener("background", event => { if (event instanceof BackgroundEvent) delivery.receive(event.result); });
		const completion = result();
		events.dispatchEvent(new BackgroundEvent(completion));
		const message = await received.promise;
		expect(sent).toHaveLength(1);
		expect(message.customType).toBe("async-result");
		expect(message.attribution).toBe("agent");
	});

	test("root, sibling, other-session, and old-transcript notifications cannot wake the wrong context", () => {
		const owner: ExecutionIdentity = { sessionId: "root", contextId: "omp-child:Worker" };
		let current: ExecutionIdentity | undefined = owner;
		const sent: StructuredMessage[] = [];
		const owned = new Map([[owner.contextId, owner]]);
		const delivery = new BackgroundDelivery({ sendMessage: message => { sent.push(structuredMessage(message)); } }, () => current, owned);
		const events = new EventTarget();
		events.addEventListener("background", event => { if (event instanceof BackgroundEvent) delivery.receive(event.result); });
		for (const completion of [result(), result("omp-sibling:Worker"), result(owner.contextId, "other-root")]) {
			events.dispatchEvent(new BackgroundEvent(completion));
		}
		expect(sent).toHaveLength(0);
		events.dispatchEvent(new BackgroundEvent(result(owner.contextId)));
		expect(sent).toHaveLength(1);
		current = { sessionId: "replacement", contextId: "new-child:Worker" };
		events.dispatchEvent(new BackgroundEvent(result(owner.contextId)));
		current = undefined; // Session shutdown invalidates even a late already-queued callback.
		events.dispatchEvent(new BackgroundEvent(result(owner.contextId)));
		expect(sent).toHaveLength(1);
	});

	test("foreign unowned contexts are rejected and binding/device switches do not rewrite completed output", () => {
		const owner: ExecutionIdentity = { sessionId: "root", contextId: "omp-main:Main" };
		const owned = new Map<string, ExecutionIdentity>();
		const sent: StructuredMessage[] = [];
		const delivery = new BackgroundDelivery({ sendMessage: message => { sent.push(structuredMessage(message)); } }, () => owner, owned);
		delivery.receive(result());
		expect(sent).toHaveLength(0);
		owned.set(owner.contextId, owner);
		delivery.receive(result(owner.contextId, owner.sessionId, "new-device"));
		delivery.receive(result(owner.contextId, owner.sessionId, "old-device"));
		expect(sent).toHaveLength(2);
		expect(sent[1]?.details).toMatchObject({ clientBridge: { target: { device: { id: "old-device" } } } });
	});
});
