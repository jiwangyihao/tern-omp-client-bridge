// SPDX-License-Identifier: MPL-2.0
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage, ModelRegistry, SessionManager, Settings, SqliteAuthCredentialStore } from "@oh-my-pi/pi-coding-agent";
import { findScopedSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { nativeMetadata, type NativeMetadata } from "../../src/omp/native-metadata.ts";

/** Real ExtensionRunner lifecycle dispatch; no model calls, auth credentials, or user configuration. */
test("same-cwd child runners capture their own Settings overlays across interleaved lifecycle handlers", async () => {
	const directory = await mkdtemp(join(tmpdir(), "omp-scoped-policy-"));
	const database = new Database(":memory:");
	const parent = Settings.isolated({ "bash.patterns": [] });
	const childA = parent.overlay({ "bash.patterns": [{ match: "deny-child-a *", approval: "deny" }] });
	const childB = parent.overlay({ "bash.patterns": [{ match: "deny-child-b *", approval: "deny" }] });
	const cwd = parent.getCwd();
	const auth = new AuthStorage(new SqliteAuthCredentialStore(database));
	const models = new ModelRegistry(auth, join(directory, "models.yml"), { ignoreLocalModelConfig: true, cacheDbPath: join(directory, "models.db"), settings: parent });
	const errors: string[] = [];
	const runners: ExtensionRunner[] = [];
	try {
		async function fixture(settings: Settings, id: string) {
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const captured = Promise.withResolvers<NativeMetadata>();
			const runtime = new ExtensionRuntime();
			const manager = SessionManager.inMemory(cwd);
			const extension = await loadExtensionFromFactory(api => {
				api.on("session_start", async (_event, ctx) => {
					entered.resolve();
					await release.promise;
					try {
						// This is the same public lifecycle seam used by the shipped extension.
						const scoped = findScopedSettings(ctx.cwd);
						if (!scoped) throw new Error("Native lifecycle lost its Settings scope");
						captured.resolve(nativeMetadata(api, () => ctx, scoped).bash);
					} catch (error) {
						captured.reject(error);
					}
				});
			}, cwd, new EventBus(), runtime, `<scoped-policy-${id}>`);
			const runner = new ExtensionRunner([extension], runtime, cwd, manager, models, undefined, settings, { getSessionId: () => "root-session" }, undefined, { kind: "sub", id, name: "task", depth: 1, parentId: "Main" });
			runner.onError(error => { errors.push(error.error); entered.reject(new Error(error.error)); captured.reject(new Error(error.error)); });
			runners.push(runner);
			return { runner, entered, release, captured };
		}
		const a = await fixture(childA, "A");
		const b = await fixture(childB, "B");
		const runningA = a.runner.emit({ type: "session_start" });
		await a.entered.promise;
		const runningB = b.runner.emit({ type: "session_start" });
		await b.entered.promise;
		// A newer same-cwd sibling makes an unscoped cwd lookup unsafe. Neither handler
		// may use that sibling's policy, even after an await and reverse completion order.
		const decoy = parent.overlay({ "bash.patterns": [{ match: "deny-decoy *", approval: "deny" }] });
		expect(decoy.getCwd()).toBe(cwd);
		b.release.resolve();
		await runningB;
		a.release.resolve();
		await runningA;
		const [metadataA, metadataB] = await Promise.all([a.captured.promise, b.captured.promise]);
		if (typeof metadataA.approval !== "function" || typeof metadataB.approval !== "function") throw new Error("Native Bash policy resolver missing");
		expect(metadataA.approval({ command: "deny-child-a fixture" })).toMatchObject({ policy: "deny" });
		expect(metadataA.approval({ command: "deny-child-b fixture" })).toBe("exec");
		expect(metadataB.approval({ command: "deny-child-b fixture" })).toMatchObject({ policy: "deny" });
		expect(metadataB.approval({ command: "deny-child-a fixture" })).toBe("exec");
		expect(metadataA.approval({ command: "deny-decoy fixture" })).toBe("exec");
		expect(metadataB.approval({ command: "deny-decoy fixture" })).toBe("exec");
		expect(errors).toEqual([]);
	} finally {
		for (const runner of runners) { runner.clearManagedTimers(); runner.disposeFileFallbacks(); }
		database.close();
		await rm(directory, { recursive: true, force: true });
	}
});
