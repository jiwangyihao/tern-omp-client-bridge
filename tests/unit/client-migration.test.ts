// SPDX-License-Identifier: MPL-2.0
import { afterEach, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { loadClientIdentity, writePrivateJson } from "../../src/config.ts";
import { saveClientResumePlan, resumeClient, type ClientResumePlan } from "../../src/client-resume.ts";
import { inspectLegacyClientMigration, stopLegacyClientForMigration, type LegacyMigrationSystem, type LegacyProcessEvidence } from "../../src/client-migration.ts";
import { requestClientUpdate, type ManagedOptions, type ServiceHealth } from "../../src/setup-managed.ts";
import { inspectSetupPackage } from "../../src/setup-payload.ts";
import { readOptionalJson } from "../../src/setup-state.ts";

const root = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function lifecycleFixture(status: number, body: unknown = {}) {
	let requests = 0;
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
		requests++;
		expect(request.headers.get("authorization")).toBe("Bearer synthetic-lifecycle-token");
		return Response.json(body, { status });
	} });
	cleanup.push(() => server.stop(true));
	const record = { schema: 1 as const, kind: "client" as const, ownership: "managed" as const, pid: process.pid, instance: crypto.randomUUID(), host: "fixture-host", packageRoot: root, runtime: process.execPath, packageDigest: "a".repeat(64) };
	const health: ServiceHealth = { endpoint: { url: `http://127.0.0.1:${server.port}`, token: "synthetic-lifecycle-token", pid: process.pid }, connected: true, deviceId: "fixture-device", sessionReady: false };
	return { record, health, requests: () => requests };
}

test("lifecycle 404 is permanently legacy, never busy or a shutdown request", async () => {
	const f = lifecycleFixture(404);
	expect(await requestClientUpdate(f.record, f.health, "fixture-device")).toBe("legacy");
	expect(f.requests()).toBe(1);
});

test("observational ownership is unmanaged and never probes shutdown", async () => {
	const f = lifecycleFixture(404);
	expect(await requestClientUpdate({ ...f.record, ownership: "existing" }, f.health, "fixture-device")).toBe("unmanaged");
	expect(f.requests()).toBe(0);
});

for (const status of [401, 403, 500]) test(`lifecycle ${status} fails closed instead of deferring as busy`, async () => {
	const f = lifecycleFixture(status);
	await expect(requestClientUpdate(f.record, f.health, "fixture-device")).rejects.toMatchObject({ code: "SERVICE_CONFLICT" });
	expect(f.requests()).toBe(1);
});

test("authenticated lifecycle ownership mismatch cannot stop a client", async () => {
	const f = lifecycleFixture(200, { schema: 1, kind: "client-lifecycle", pid: process.pid, instance: crypto.randomUUID(), packageDigest: "a".repeat(64), deviceId: "fixture-device", busy: false, draining: false });
	await expect(requestClientUpdate(f.record, f.health, "fixture-device")).rejects.toMatchObject({ code: "SERVICE_CONFLICT" });
	expect(f.requests()).toBe(1);
});

for (const busy of [false, true]) test(`modern ${busy ? "busy state defers" : "approval revocation aborts"} without shutdown`, async () => {
	const body = { schema: 1, kind: "client-lifecycle", pid: process.pid, instance: crypto.randomUUID(), packageDigest: "a".repeat(64), deviceId: "fixture-device", busy, draining: false };
	const f = lifecycleFixture(200, body);
	f.record.instance = body.instance;
	if (busy) expect(await requestClientUpdate(f.record, f.health, "fixture-device")).toBe("busy");
	else await expect(requestClientUpdate(f.record, f.health, "fixture-device", async () => { throw new Error("approval revoked"); })).rejects.toThrow("approval revoked");
	expect(f.requests()).toBe(1);
});

async function migrationFixture() {
	const data = await mkdtemp(path.join(os.tmpdir(), "bridge-migration-unit-"));
	cleanup.push(() => rm(data, { recursive: true, force: true }));
	const stateDir = path.join(data, "bridge");
	const identity = await loadClientIdentity(stateDir);
	const snapshot = await inspectSetupPackage(root);
	const stage = path.join(data, "old-source");
	for (const file of snapshot.files) {
		const destination = path.join(stage, file);
		await mkdir(path.dirname(destination), { recursive: true });
		await cp(path.join(root, file), destination);
	}
	await writeFile(path.join(stage, "README.md"), "Synthetic legacy package fixture.\n");
	const oldDigest = (await inspectSetupPackage(stage)).digest;
	const oldRoot = path.join(data, "installation", "packages", oldDigest);
	await mkdir(path.dirname(oldRoot), { recursive: true });
	await rename(stage, oldRoot);
	await writePrivateJson(path.join(oldRoot, ".bridge-installation.json"), { schema: 1, source: oldDigest, runtime: `${process.platform}-${process.arch}` });
	const plan: ClientResumePlan = { schema: 1, kind: "client-resume", host: "fixture-host", remoteCommand: "fixture-relay", stateDir, controlFile: path.join(stateDir, "client.json"), packageRoot: root, runtime: process.execPath, deviceId: identity.device.id, packageDigest: snapshot.digest };
	await writePrivateJson(path.join(data, "config.json"), { controlFile: plan.controlFile });
	await saveClientResumePlan(data, plan);
	let authorized = true;
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
		if (!authorized || request.headers.get("authorization") !== "Bearer synthetic-migration-token") return new Response("unauthorized", { status: 401 });
		if (new URL(request.url).pathname === "/v1/state") return Response.json({ device: identity.device, connected: true, serverName: "fixture-host", views: {}, transfers: [], interactions: [], panels: [], outcomes: [] });
		return new Response("legacy", { status: 404 });
	} });
	cleanup.push(() => server.stop(true));
	await writePrivateJson(plan.controlFile, { url: `http://127.0.0.1:${server.port}`, token: "synthetic-migration-token", pid: process.pid });
	const startedAt = Date.now() - 1000;
	const owner = { schema: 1 as const, kind: "client" as const, ownership: "managed" as const, pid: process.pid, instance: crypto.randomUUID(), startedAt, host: plan.host, packageRoot: oldRoot, packageDigest: oldDigest, runtime: process.execPath };
	await writePrivateJson(path.join(stateDir, "client.managed.json"), owner);
	await writePrivateJson(path.join(stateDir, "client.service.lock"), { schema: 1, pid: process.pid, instance: crypto.randomUUID() });
	const evidence: LegacyProcessEvidence = { uid: process.getuid!(), startedAt: startedAt - 1000, command: [owner.runtime, path.join(oldRoot, "src", "cli.ts"), "managed-service", "--kind", "client", "--state-dir", stateDir, "--package-root", oldRoot, "--host", plan.host, "--remote-command", plan.remoteCommand, "--expected-device-id", plan.deviceId].join(" "), executable: await realpath(process.execPath), listenerPid: process.pid };
	const signals: number[] = [];
	let now = 0;
	let running = false;
	const dependencies: LegacyMigrationSystem = { inspectProcess: async () => evidence, terminate: pid => { signals.push(pid); }, exists: () => running, sleep: async ms => { now += ms; }, now: () => now };
	const options: ManagedOptions = { kind: "client", stateDir, packageRoot: root, host: plan.host, remoteCommand: plan.remoteCommand, expectedDeviceId: plan.deviceId, expectedPackageDigest: plan.packageDigest, expectedResumeDigest: createHash("sha256").update(JSON.stringify(plan)).digest("hex"), resumePluginData: data, clientMaintenance: "update" };
	return { data, plan, stateDir, owner, evidence, dependencies, signals, options, revokeEndpoint: () => { authorized = false; }, keepRunning: () => { running = true; } };
}

test.skipIf(process.platform === "win32")("legacy resume outcome carries no automatic retry delay", async () => {
	const f = await migrationFixture();
	const result = await resumeClient(f.data);
	expect(result).toMatchObject({ updateDeferred: "legacy", upgradeRequired: true, reused: true });
	expect(result.retryAfterMs).toBeUndefined();
	expect(f.signals).toEqual([]);
});

test.skipIf(process.platform === "win32")("explicit legacy preview is read-only and exact confirmed path sends one graceful termination", async () => {
	const f = await migrationFixture();
	const files = ["client-resume.json", "config.json", "bridge/identity.json", "bridge/client.managed.json", "bridge/client.service.lock", "bridge/client.json"];
	const before = await Promise.all(files.map(file => readFile(path.join(f.data, file), "utf8")));
	const preview = await inspectLegacyClientMigration(f.data, f.dependencies);
	expect(preview.warning).toContain("cannot prove");
	expect(preview.warning).toContain("context state");
	expect(await readOptionalJson(path.join(f.data, "setup.lock"))).toBeUndefined();
	expect(await readOptionalJson(path.join(f.stateDir, "client.launch.lock"))).toBeUndefined();
	expect(f.signals).toEqual([]);
	await stopLegacyClientForMigration({ ...f.options, legacyMigrationConfirmation: preview.confirmation }, f.dependencies);
	expect(f.signals).toEqual([f.owner.pid]);
	expect(await Promise.all(files.map(file => readFile(path.join(f.data, file), "utf8")))).toEqual(before);
});

for (const change of ["uid", "startedAt", "command", "executable", "listenerPid"] as const) test.skipIf(process.platform === "win32")(`legacy migration refuses OS ${change} ownership mismatch`, async () => {
	const f = await migrationFixture();
	if (change === "uid") f.evidence.uid++;
	else if (change === "startedAt") f.evidence.startedAt += 300000;
	else if (change === "listenerPid") f.evidence.listenerPid++;
	else f.evidence[change] += "-different";
	await expect(inspectLegacyClientMigration(f.data, f.dependencies)).rejects.toMatchObject({ code: "CLIENT_MIGRATION_OWNERSHIP" });
	expect(f.signals).toEqual([]);
});

for (const revoke of ["approval", "endpoint", "instance"] as const) test.skipIf(process.platform === "win32")(`legacy execution rechecks ${revoke} after confirmation`, async () => {
	const f = await migrationFixture();
	const preview = await inspectLegacyClientMigration(f.data, f.dependencies);
	if (revoke === "approval") await rm(path.join(f.data, "client-resume.json"));
	else if (revoke === "endpoint") f.revokeEndpoint();
	else await writePrivateJson(path.join(f.stateDir, "client.managed.json"), { ...f.owner, instance: crypto.randomUUID() });
	await expect(stopLegacyClientForMigration({ ...f.options, legacyMigrationConfirmation: preview.confirmation }, f.dependencies)).rejects.toBeDefined();
	expect(f.signals).toEqual([]);
});

test.skipIf(process.platform === "win32")("stale explicit confirmation is rejected before any signal", async () => {
	const f = await migrationFixture();
	await expect(stopLegacyClientForMigration({ ...f.options, legacyMigrationConfirmation: "0".repeat(64) }, f.dependencies)).rejects.toMatchObject({ code: "CLIENT_MIGRATION_CONFIRMATION_STALE" });
	expect(f.signals).toEqual([]);
});

test.skipIf(process.platform === "win32")("approval revoked during OS inspection cannot reach termination", async () => {
	const f = await migrationFixture();
	const preview = await inspectLegacyClientMigration(f.data, f.dependencies);
	f.dependencies.inspectProcess = async () => {
		await rm(path.join(f.data, "client-resume.json"));
		return f.evidence;
	};
	await expect(stopLegacyClientForMigration({ ...f.options, legacyMigrationConfirmation: preview.confirmation }, f.dependencies)).rejects.toMatchObject({ code: "CLIENT_RESUME_SETUP_REQUIRED" });
	expect(f.signals).toEqual([]);
});

test.skipIf(process.platform === "win32")("legacy migration timeout never repeats or escalates graceful termination", async () => {
	const f = await migrationFixture();
	f.keepRunning();
	const preview = await inspectLegacyClientMigration(f.data, f.dependencies);
	await expect(stopLegacyClientForMigration({ ...f.options, legacyMigrationConfirmation: preview.confirmation }, f.dependencies)).rejects.toMatchObject({ code: "CLIENT_UPDATE_PENDING" });
	expect(f.signals).toEqual([f.owner.pid]);
});

test("legacy execution cannot bypass current approval with only a confirmation", async () => {
	const data = await mkdtemp(path.join(os.tmpdir(), "bridge-migration-unapproved-"));
	cleanup.push(() => rm(data, { recursive: true, force: true }));
	await expect(resumeClient(data, "a".repeat(64))).rejects.toMatchObject({ code: "CLIENT_MIGRATION_CONFIRMATION_REQUIRED" });
	expect(await readOptionalJson(path.join(data, "client-resume.json"))).toBeUndefined();
});
