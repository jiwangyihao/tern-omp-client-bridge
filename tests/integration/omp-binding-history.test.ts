// SPDX-License-Identifier: MPL-2.0
import { expect, test } from "bun:test";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { convertToLlm, normalizeCustomMessagePayload } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { ServerState } from "../../src/api.ts";
import { bindingMessage } from "../../src/omp/binding-history.ts";

const stateFor = (sessionId: string): ServerState => ({
	serverInstance: "synthetic-broker", binding: { sessionId, clientId: null, revision: 0, change: null }, devices: [],
});
const text = "Client target: unbound; revision 0. Synthetic binding fixture.";

function commit(manager: SessionManager, state: ServerState, content = text) {
	const payload = bindingMessage(manager, state, content);
	if (!payload) throw new Error("Expected a new binding snapshot");
	const message = normalizeCustomMessagePayload(payload);
	return manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details, message.attribution);
}

test("binding dedup uses committed host history, not failed or cancelled preparation views", () => {
	const manager = SessionManager.inMemory("/synthetic-binding-fixture");
	const state = stateFor(manager.getSessionId());
	const prepared = bindingMessage(manager, state, text);
	expect(prepared).toBeDefined();
	// Neither a rejected preparation nor a cancelled request commits this payload.
	expect(bindingMessage(manager, state, text)).toEqual(prepared);
	expect(manager.getBranch()).toHaveLength(0);
	commit(manager, state);
	expect(bindingMessage(manager, state, text)).toBeUndefined();
	// A fresh caller (resume/reload) derives dedup from the persisted branch.
	expect(bindingMessage(manager, structuredClone(state), text)).toBeUndefined();
});

test("three rounds retain binding position and developer priority in real host conversion", () => {
	const manager = SessionManager.inMemory("/synthetic-binding-fixture");
	const state = stateFor(manager.getSessionId());
	manager.appendMessage({ role: "user", content: "synthetic user", timestamp: 1 });
	manager.appendMessage({ role: "developer", content: "synthetic resume notification", timestamp: 2 });
	commit(manager, state);
	const prefix = convertToLlm(manager.buildSessionContext().messages);
	expect(prefix.at(-1)?.role).toBe("developer");
	for (let round = 0; round < 3; round++) {
		// Clearly synthetic signed-thinking/tool responses; no provider was contacted.
		const id = `synthetic-tool-${round}`;
		manager.appendMessage({ role: "assistant", api: "anthropic-messages", provider: "anthropic", model: "synthetic-model",
			content: [{ type: "thinking", thinking: "Synthetic reasoning", thinkingSignature: `synthetic-signature-${round}` },
				{ type: "toolCall", id, name: "read", arguments: { path: "/synthetic/not-executed" } }],
			usage: { input: round, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: round + 1,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "toolUse", responseId: `synthetic-response-${round}`, timestamp: 3 + round * 2 });
		manager.appendMessage({ role: "toolResult", toolCallId: id, toolName: "read",
			content: [{ type: "text", text: "Synthetic result, no operation executed" }], isError: false, timestamp: 4 + round * 2 });
		expect(bindingMessage(manager, state, text)).toBeUndefined();
		const converted = convertToLlm(manager.buildSessionContext().messages);
		expect(converted.slice(0, prefix.length)).toEqual(prefix);
		expect(converted.some(message => message.role === "assistant" && message.content.some(block =>
			block.type === "thinking" && block.thinkingSignature === `synthetic-signature-${round}`))).toBe(true);
		expect(manager.getBranch().filter(entry => entry.type === "custom_message")).toHaveLength(1);
	}
});

test("genuine changes append snapshots including equal text with different broker ownership", () => {
	const manager = SessionManager.inMemory("/synthetic-binding-fixture");
	const state = stateFor(manager.getSessionId());
	commit(manager, state);
	const original = structuredClone(manager.getBranch());
	commit(manager, { ...state, serverInstance: "replacement-broker" });
	const changed = { ...state, serverInstance: "replacement-broker", binding: { ...state.binding, revision: 1 } };
	commit(manager, changed, "Client target: unbound; revision 1. Synthetic binding fixture.");
	expect(manager.getBranch().slice(0, original.length)).toEqual(original);
	expect(manager.getBranch().filter(entry => entry.type === "custom_message")).toHaveLength(3);
});

test("same text from an unrelated source or old unowned snapshot is not authoritative", () => {
	const manager = SessionManager.inMemory("/synthetic-binding-fixture");
	const state = stateFor(manager.getSessionId());
	manager.appendCustomMessageEntry("unrelated-notification", text, false);
	manager.appendCustomMessageEntry("client-bridge-binding", text, false);
	expect(bindingMessage(manager, state, text)).toBeDefined();
	commit(manager, state);
	expect(bindingMessage(manager, state, text)).toBeUndefined();
});

test("branch, compaction, reset and session boundaries consult host-resolved live history", async () => {
	const manager = SessionManager.inMemory("/synthetic-binding-fixture");
	const state = stateFor(manager.getSessionId());
	const root = manager.appendMessage({ role: "user", content: "before binding", timestamp: 1 });
	const binding = commit(manager, state);
	manager.branch(root);
	expect(bindingMessage(manager, state, text)).toBeDefined();
	manager.branch(binding);
	expect(bindingMessage(manager, state, text)).toBeUndefined();
	const keep = manager.appendMessage({ role: "user", content: "kept after compaction", timestamp: 2 });
	manager.appendCompaction("Synthetic summary", "Synthetic", keep, 100);
	expect(bindingMessage(manager, state, text)).toBeDefined();
	commit(manager, state);
	expect(bindingMessage(manager, state, text)).toBeUndefined();
	manager.appendResetBoundary();
	expect(bindingMessage(manager, state, text)).toBeDefined();
	await manager.newSession();
	const next = stateFor(manager.getSessionId());
	expect(bindingMessage(manager, next, text)).toBeDefined();
	commit(manager, next);
	expect(bindingMessage(manager, next, text)).toBeUndefined();
});

test("inherited snapshots never establish ownership in another session", async () => {
	const manager = SessionManager.inMemory("/synthetic-binding-fixture");
	const originalState = stateFor(manager.getSessionId());
	const inherited = normalizeCustomMessagePayload(bindingMessage(manager, originalState, text)!);
	await manager.newSession();
	manager.appendCustomMessageEntry(inherited.customType, inherited.content, inherited.display, inherited.details, inherited.attribution);
	// Even a child sharing the root binding must own its own persisted snapshot.
	expect(bindingMessage(manager, originalState, text)).toBeDefined();
	commit(manager, originalState);
	expect(bindingMessage(manager, originalState, text)).toBeUndefined();
	const switched = stateFor(manager.getSessionId());
	expect(bindingMessage(manager, switched, text)).toBeDefined();
});

test("discarding a changed snapshot cannot rewrite or consume the last committed binding", () => {
	const manager = SessionManager.inMemory("/synthetic-binding-fixture");
	const state = stateFor(manager.getSessionId());
	commit(manager, state);
	const original = structuredClone(manager.getBranch());
	const changed = { ...state, binding: { ...state.binding, clientId: "synthetic-other-device", revision: 1 } };
	const prepared = bindingMessage(manager, changed, text);
	expect(prepared).toBeDefined();
	expect(bindingMessage(manager, changed, text)).toEqual(prepared);
	expect(manager.getBranch()).toEqual(original);
	expect(bindingMessage(manager, state, text)).toBeUndefined();
	commit(manager, changed);
	expect(manager.getBranch().slice(0, original.length)).toEqual(original);
	expect(bindingMessage(manager, changed, text)).toBeUndefined();
});
