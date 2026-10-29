// SPDX-License-Identifier: MPL-2.0
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage, ModelRegistry, SessionManager, Settings, SqliteAuthCredentialStore } from "@oh-my-pi/pi-coding-agent";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionActions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import type { BrokerApi, ServerState } from "../../src/api.ts";
import { startBroker } from "../../src/broker.ts";
import { BrokerClient } from "../../src/broker-client.ts";
import { startClientService, type ClientService } from "../../src/client.ts";
import { loadClientIdentity } from "../../src/config.ts";
import { bindingDescription, installClientBridge } from "../../src/omp/extension.ts";
import { LocalUiStateSchema, UiIntentReceiptSchema } from "../../src/schemas.ts";
import { eventually, nativeDraftHost } from "../fixtures/native-draft.ts";

/** Real broker HTTP/watch/claims and native ExtensionRunner lifecycle; no model or desktop. */
test("broker restart resets native visible/model binding and retired callbacks cannot restore it", async () => {
	const root = await mkdtemp(join(tmpdir(), "bridge-binding-lifecycle-"));
	const stateDir = join(root, "server");
	const database = new Database(":memory:");
	const settings = Settings.isolated({});
	const manager = SessionManager.inMemory(settings.getCwd());
	const sessionId = manager.getSessionId();
	const native = await nativeDraftHost(manager);
	const auth = new AuthStorage(new SqliteAuthCredentialStore(database));
	const models = new ModelRegistry(auth, join(root, "models.yml"), { ignoreLocalModelConfig: true, cacheDbPath: join(root, "models.db"), settings });
	const clientDir = join(root, "client");
	const identity = await loadClientIdentity(clientDir, { name: "Lifecycle fixture" });
	let server = await startBroker({ stateDir });
	let client: ClientService | undefined;
	const transport = new BrokerClient({ stateDir });
	const callbacks: Array<(state: ServerState) => void> = [];
	const claims = new Map<string, ServerState>();
	const finished = new Map<string, string | undefined>();
	const broker: BrokerApi = {
		state: id => transport.state(id),
		invoke: (...args) => transport.invoke(...args),
		openDraft: (...args) => transport.openDraft(...args),
		claimIntent: async (...args) => { const claim = await transport.claimIntent(...args); claims.set(claim.id, claim.state); return claim; },
		finishIntent: async (id, error) => { await transport.finishIntent(id, error); finished.set(id, error); },
		closeContext: (...args) => transport.closeContext(...args),
		close: () => transport.close(),
		watch(id, onState, onError, onBackground) {
			callbacks.push(onState);
			return transport.watch(id, onState, onError, onBackground);
		},
	};
	let status: string | undefined;
	const statusWaiters = new Set<() => void>();
	const queued: unknown[] = [];
	const errors: string[] = [];
	const runtime = new ExtensionRuntime();
	const extension = await loadExtensionFromFactory(api => installClientBridge(api, broker), settings.getCwd(), new EventBus(), runtime, "<binding-lifecycle>");
	const runner = new ExtensionRunner([extension], runtime, settings.getCwd(), manager, models, undefined, settings);
	const unused = (): never => { throw new Error("Unexpected native action in binding-only fixture"); };
	const actions: ExtensionActions = {
		sendMessage: (message, options) => { expect(options).toEqual({ deliverAs: "nextTurn", triggerTurn: false }); queued.push(message); },
		sendUserMessage: unused, appendEntry: unused, setLabel: unused,
		getActiveTools: () => [], getAllTools: () => [], setActiveTools: unused,
		getCommands: () => [], setModel: unused, getThinkingLevel: () => "off", setThinkingLevel: unused,
		getSessionName: () => undefined, setSessionName: unused,
	};
	runner.initialize(actions, { getModel: () => undefined, isIdle: () => true, abort: unused, hasPendingMessages: () => false, shutdown: unused, getContextUsage: () => undefined, compact: unused, getSystemPrompt: () => [] }, undefined, {
		...native.ui,
		setStatus: (_key, value) => { status = value; for (const notify of statusWaiters) notify(); },
	}, "tui");
	runner.onError(error => { errors.push(error.error); });
	async function visible(state: ServerState) {
		const expected = bindingDescription(state);
		if (status !== expected) {
			let notify: (() => void) | undefined;
			try {
				await new Promise<void>(resolve => {
					notify = () => { if (status === expected) resolve(); };
					statusWaiters.add(notify);
				});
			} finally { if (notify) statusWaiters.delete(notify); }
		}
		expect((await runner.emitContext([])).at(-1)).toMatchObject({ role: "custom", content: expected });
	}
	async function startViewer() {
		client = await startClientService({ stateDir: clientDir, cwd: root, identity, serverName: "Lifecycle fixture", connection: { kind: "loopback", endpoint: server.endpoint } });
		await client.waitForConnection(AbortSignal.timeout(10000));
	}
	async function intent(body: unknown) {
		if (!client) throw new Error("Viewer not connected");
		const response = await fetch(client.endpoint.url + "/v1/intents", { method: "POST", headers: { authorization: `Bearer ${client.endpoint.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
		expect(response.ok).toBe(true);
		const receipt = UiIntentReceiptSchema.parse(await response.json());
		await eventually(() => finished.has(receipt.id), Boolean);
		expect(finished.get(receipt.id)).toBeUndefined();
		return claims.get(receipt.id)!;
	}
	async function resolveViewer() {
		const destinationId = await eventually(native.destinationId, id => id !== undefined);
		const resolved = await intent({ kind: "resolve", viewId: "fixture-view", destinationId });
		// The state endpoint is the same real API used by Tern. Wait for its
		// independently delivered view before submitting the binding intent.
		const signal = AbortSignal.timeout(10000);
		for (;;) {
			if (!client) throw new Error("Viewer closed");
			const state = LocalUiStateSchema.parse(await (await fetch(client.endpoint.url + "/v1/state", { headers: { authorization: `Bearer ${client.endpoint.token}` }, signal })).json());
			if (state.views["fixture-view"]) return resolved;
			signal.throwIfAborted();
		}
	}
	async function bindViewer() {
		if (!client) throw new Error("Viewer not connected");
		const state = LocalUiStateSchema.parse(await (await fetch(client.endpoint.url + "/v1/state", { headers: { authorization: `Bearer ${client.endpoint.token}` } })).json());
		const view = state.views["fixture-view"];
		if (!view) throw new Error("Native draft has not resolved");
		return intent({ kind: "bind", viewId: view.viewId, sessionId: view.sessionId, draftToken: view.draftToken, clientId: identity.device.id, expectedRevision: 0 });
	}
	try {
		await startViewer();
		await runner.emit({ type: "session_start" });
		const initial = await resolveViewer();
		const firstDestination = native.destinationId();
		if (!firstDestination) throw new Error("Native draft destination was not published");
		await visible(initial);
		const old = await bindViewer();
		expect(old.serverInstance).toBe(initial.serverInstance);
		expect(old.binding.revision).toBe(1);
		await visible(old);
		const firstCallback = callbacks[0]!;
		firstCallback(initial); // Stale same-generation revision must not roll back.
		expect(status).toBe(bindingDescription(old));
		const oldDraft = LocalUiStateSchema.parse(await (await fetch(client!.endpoint.url + "/v1/state", { headers: { authorization: `Bearer ${client!.endpoint.token}` } })).json()).views["fixture-view"]!;
		await runner.emitInput("extension-authored input", undefined, "extension");
		await resolveViewer();
		const unchanged = LocalUiStateSchema.parse(await (await fetch(client!.endpoint.url + "/v1/state", { headers: { authorization: `Bearer ${client!.endpoint.token}` } })).json()).views["fixture-view"]!;
		expect(unchanged.draftToken).toBe(oldDraft.draftToken);
		await runner.emitInput("actual interactive submission", undefined, "interactive");
		await resolveViewer();
		const submitted = LocalUiStateSchema.parse(await (await fetch(client!.endpoint.url + "/v1/state", { headers: { authorization: `Bearer ${client!.endpoint.token}` } })).json()).views["fixture-view"]!;
		expect(submitted.destinationId).toBe(firstDestination);
		expect(submitted.draftToken).not.toBe(oldDraft.draftToken);
		await client!.close(); client = undefined;
		await server.close();
		await eventually(native.destinationId, id => id === undefined);
		server = await startBroker({ stateDir });
		const restarted = await transport.state(sessionId);
		expect(restarted.serverInstance).not.toBe(old.serverInstance);
		expect(restarted.binding).toMatchObject({ clientId: null, revision: 0 });
		await visible(restarted); // Real BrokerClient reconnect reads the replacement endpoint.
		const queuedAfterRestart = queued.length;
		firstCallback(old); // A late HTTP claim/watch callback from the retired broker.
		expect(status).toBe(bindingDescription(restarted));
		expect(queued).toHaveLength(queuedAfterRestart);
		await visible(restarted);
		await startViewer();
		const newInitial = await resolveViewer();
		expect(native.destinationId()).not.toBe(firstDestination);
		expect(newInitial.serverInstance).toBe(restarted.serverInstance);
		const current = await bindViewer();
		await visible(current);
		firstCallback(restarted);
		expect(status).toBe(bindingDescription(current));
		status = undefined; // Require a fresh watch delivery, not the previous status text.
		await runner.emit({ type: "session_start" }); // Same conversation, new watch ownership.
		await visible(current);
		firstCallback({ ...initial, serverInstance: "late-unseen-owner" });
		expect<string | undefined>(status).toBe(bindingDescription(current));
		const previousDestination = await eventually(native.destinationId, id => id !== undefined);
		await manager.newSession();
		await runner.emit({ type: "session_switch", reason: "new", previousSessionFile: undefined });
		const switched = await resolveViewer();
		expect(native.destinationId()).not.toBe(previousDestination);
		expect(switched.binding).toMatchObject({ sessionId: manager.getSessionId(), clientId: null, revision: 0 });
		await visible(switched);
		const stale = await fetch(client!.endpoint.url + "/v1/intents", { method: "POST", headers: { authorization: `Bearer ${client!.endpoint.token}`, "content-type": "application/json" }, body: JSON.stringify({ kind: "resolve", viewId: "stale-session-view", destinationId: previousDestination }) });
		expect(stale.ok).toBe(false);
		expect(errors).toEqual([]);
	} finally {
		await runner.emit({ type: "session_shutdown" });
		expect(native.destinationNode()).toBeUndefined();
		native.controller.disposeComposerShapes();
		runner.clearManagedTimers(); runner.disposeFileFallbacks();
		transport.close();
		await Promise.allSettled([client?.close(), server.close()]);
		database.close();
		await rm(root, { recursive: true, force: true });
	}
}, 30000);
