// SPDX-License-Identifier: MPL-2.0
import { afterEach, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { packageFiles } from "../../scripts/build.ts";
import { startBroker } from "../../src/broker.ts";
import { BrokerClient } from "../../src/broker-client.ts";
import type { DraftDestination } from "../../src/api.ts";
import { startClientService } from "../../src/client.ts";
import { loadClientIdentity, readEndpoint, writePrivateJson } from "../../src/config.ts";
import type { Endpoint } from "../../src/config.ts";
import { ensureManagedService, ManagedResultSchema, serviceHealth } from "../../src/setup-managed.ts";
import { packageArchive, shellArgument } from "../../src/setup-remote.ts";
import { processExists, readOptionalJson, SetupProgressSchema } from "../../src/setup-state.ts";
import { SetupResultSchema, setupRegistration } from "../../src/setup.ts";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const cli = path.join(packageRoot, "src", "cli.ts");
const roots: string[] = [];
const ownedStates: { kind: "server" | "client"; stateDir: string }[] = [];
const RecordSchema = z.object({ pid: z.number(), ownership: z.literal("managed") });

async function fixture(): Promise<string> {
	const root = await mkdtemp(path.join(os.tmpdir(), "tern setup 'fixture'-"));
	roots.push(root);
	return root;
}

afterEach(async () => {
	// Snapshot both registries before awaiting: even a failed hook must never delete a later fixture.
	const states = ownedStates.splice(0).reverse();
	const directories = roots.splice(0);
	const errors: Error[] = [];
	for (const state of states) {
		try {
			const recordFile = path.join(state.stateDir, `${state.kind}.managed.json`);
			const saved = await readOptionalJson(recordFile);
			if (saved === undefined) continue;
			const record = RecordSchema.parse(saved);
			if (!processExists(record.pid)) continue;
			if (record.pid === process.pid) throw new Error("A fixture-owned service unexpectedly identifies the test runner");
			const endpoint = await readEndpoint(path.join(state.stateDir, `${state.kind}.json`));
			if (endpoint.pid !== record.pid) throw new Error("Fixture service ownership changed before teardown");
			await serviceHealth(state.kind, state.stateDir);
			process.kill(record.pid, "SIGTERM");
			const deadline = Date.now() + 5000;
			// A detached OS process cannot share fake timers; await its actual graceful-shutdown record removal.
			while (await readOptionalJson(recordFile) !== undefined && Date.now() < deadline) await Bun.sleep(20);
			if (await readOptionalJson(recordFile) !== undefined) throw new Error(`Managed ${state.kind} did not complete graceful shutdown within 5s; retained fixture: ${state.stateDir}`);
		} catch (error) { errors.push(error instanceof Error ? error : new Error(String(error))); }
	}
	// Preserve private logs/ownership metadata on failure instead of hiding a live-service defect.
	if (errors.length) throw new AggregateError(errors, "Fixture service teardown failed; state directories were retained for diagnosis");
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
}, 30000);

test("managed server survives initializer EOF, is reused, and authenticates health", async () => {
	const root = await fixture();
	const stateDir = path.join(root, "server");
	ownedStates.push({ kind: "server", stateDir });
	const launch = Bun.spawn([process.execPath, cli, "managed-start", "--kind", "server", "--state-dir", stateDir, "--package-root", packageRoot], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const stdout = new Response(launch.stdout).text();
	const stderr = new Response(launch.stderr).text();
	expect(await launch.exited).toBe(0);
	const first = ManagedResultSchema.parse(JSON.parse(await stdout));
	expect(await stderr).toBe("");
	expect(first).toMatchObject({ reused: false, ownership: "managed", connected: true, sessionReady: false });
	expect(first.pid).not.toBe(launch.pid);
	const endpoint = await readEndpoint(first.controlFile);
	const unauthorized = await fetch(endpoint.url + "/v1/health");
	expect(unauthorized.status).toBe(401);
	await unauthorized.arrayBuffer();
	expect((await serviceHealth("server", stateDir)).connected).toBe(true);
	const second = await ensureManagedService({ kind: "server", stateDir, packageRoot });
	expect(second).toMatchObject({ reused: true, ownership: "managed", pid: first.pid });
	expect((await readEndpoint(first.controlFile)).token).toBe(endpoint.token);
	const recorded = await readFile(path.join(stateDir, "server.managed.json"), "utf8");
	const updatedPackage = path.join(root, "updated source");
	await mkdir(updatedPackage);
	for (const entry of await packageFiles(packageRoot)) {
		const destination = path.join(updatedPackage, entry);
		await mkdir(path.dirname(destination), { recursive: true });
		await cp(path.join(packageRoot, entry), destination);
	}
	const changed = path.join(updatedPackage, "src", "setup.ts");
	await writeFile(changed, (await readFile(changed, "utf8")) + "\n// Fixture update: retained service must not claim this source.\n");
	const retained = await ensureManagedService({ kind: "server", stateDir, packageRoot: updatedPackage });
	expect(retained).toMatchObject({ pid: first.pid, reused: true, upgradeRequired: true, packageRoot: path.resolve(packageRoot) });
	expect(await readFile(path.join(stateDir, "server.managed.json"), "utf8")).toBe(recorded);
}, 60000);

test("half-installed dead service records and original broker locks are repaired", async () => {
	const root = await fixture();
	const stateDir = path.join(root, "server");
	await mkdir(stateDir);
	ownedStates.push({ kind: "server", stateDir });
	const dead = Bun.spawn([process.execPath, "-e", "process.exit(0)"], { stdout: "ignore", stderr: "ignore" });
	await dead.exited;
	const instance = crypto.randomUUID();
	await writePrivateJson(path.join(stateDir, "server.lock"), { pid: dead.pid, instance });
	await writePrivateJson(path.join(stateDir, "server.service.lock"), { schema: 1, pid: dead.pid, instance });
	await writePrivateJson(path.join(stateDir, "server.managed.json"), { schema: 1, kind: "server", pid: dead.pid, instance, ownership: "managed", startedAt: Date.now() });
	await writePrivateJson(path.join(stateDir, "server.json"), { url: "http://127.0.0.1:1", token: "interrupted-fixture-token", pid: dead.pid });
	const repaired = await ensureManagedService({ kind: "server", stateDir, packageRoot });
	expect(repaired).toMatchObject({ connected: true, ownership: "managed", reused: false });
	expect(repaired.pid).not.toBe(dead.pid);
	expect(await readOptionalJson(path.join(stateDir, "server.lock"))).toMatchObject({ pid: repaired.pid });
}, 60000);

test("existing real signed client is reused without duplicate registration or changing identity", async () => {
	const root = await fixture();
	const serverDir = path.join(root, "server");
	const stateDir = path.join(root, "client");
	const broker = await startBroker({ stateDir: serverDir });
	const identity = await loadClientIdentity(stateDir);
	const client = await startClientService({ stateDir, identity, serverName: "fixture-host", connection: { kind: "loopback", endpoint: broker.endpoint } });
	const api = new BrokerClient({ endpoint: broker.endpoint });
	try {
		await client.waitForConnection(AbortSignal.timeout(15000));
		const reused = await ensureManagedService({ kind: "client", stateDir, packageRoot, host: "fixture-host", remoteCommand: "not invoked for a healthy existing service" });
		expect(reused).toMatchObject({ reused: true, ownership: "existing", pid: process.pid, connected: true, sessionReady: false, deviceId: identity.device.id });
		expect(await loadClientIdentity(stateDir)).toEqual(identity);
		expect(await setupRegistration(serverDir, identity.device.id)).toEqual({ registered: true, deviceId: identity.device.id });
		expect((await api.state("fixture-session")).devices.filter(device => device.online)).toHaveLength(1);
		const destinationReady = Promise.withResolvers<DraftDestination>();
		const claimed = Promise.withResolvers<void>();
		api.openDraft("fixture-session", "fixture-draft", {
			onDestination: value => { if (value) destinationReady.resolve(value); },
			onIntent: intent => { void api.claimIntent(intent.id, intent.sessionId, intent.draftToken, intent.destinationId).then(() => api.finishIntent(intent.id)).then(claimed.resolve, claimed.reject); },
			onError: error => { destinationReady.reject(error); claimed.reject(error); },
		});
		const destination = await destinationReady.promise;
		const receiptResponse = await fetch(client.endpoint.url + "/v1/intents", { method: "POST", headers: { authorization: `Bearer ${client.endpoint.token}`, "content-type": "application/json" }, body: JSON.stringify({ kind: "resolve", viewId: "setup-fixture-pane", destinationId: destination.id }) });
		expect(receiptResponse.ok).toBe(true);
		await receiptResponse.json();
		await claimed.promise;
		const deadline = Date.now() + 5000;
		let ready = await serviceHealth("client", stateDir);
		// This observes a real WebSocket notification and authenticated HTTP state, not a timer-driven mock.
		while (!ready.sessionReady && Date.now() < deadline) { await Bun.sleep(20); ready = await serviceHealth("client", stateDir); }
		expect(ready.sessionReady).toBe(true);
	} finally { api.close(); await client.close(); await broker.close(); }
}, 60000);

test("manual broker restart replaces only the dead observational record after authenticated reuse", async () => {
	const root = await fixture();
	const previous = Bun.spawn([process.execPath, cli, "server", "--state-dir", root], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
	const diagnostics = new Response(previous.stderr).text();
	const reader = previous.stdout.getReader();
	let replacement: { endpoint: Endpoint; close(): Promise<void> } | undefined;
	try {
		let output = "";
		while (!output.includes("\n")) {
			const next = await reader.read();
			if (next.done) throw new Error("Foreground fixture exited before readiness");
			output += new TextDecoder().decode(next.value);
		}
		expect(JSON.parse(output.trim()).kind).toBe("broker-ready");
		const observed = await ensureManagedService({ kind: "server", stateDir: root, packageRoot });
		expect(observed).toMatchObject({ pid: previous.pid, ownership: "existing", reused: true });
		const oldRecord = z.object({ instance: z.string() }).parse(await readOptionalJson(path.join(root, "server.managed.json")));
		previous.stdin.end();
		expect(await previous.exited).toBe(0);
		expect(await diagnostics).toBe("");
		// Simulate an old owner's retained version claims as well as its observed PID.
		await writePrivateJson(path.join(root, "server.managed.json"), { schema: 1, kind: "server", pid: previous.pid, instance: oldRecord.instance, ownership: "managed", startedAt: 1, packageRoot: "/retired/package", runtime: "/retired/bun", packageDigest: "0".repeat(64) });
		replacement = await startBroker({ stateDir: root });
		const endpoint = replacement.endpoint;
		const reused = await ensureManagedService({ kind: "server", stateDir: root, packageRoot });
		expect(reused).toMatchObject({ pid: process.pid, ownership: "existing", reused: true, connected: true, upgradeRequired: false });
		expect(reused.packageRoot).toBeUndefined();
		expect(reused.runtime).toBeUndefined();
		expect(reused.packageDigest).toBeUndefined();
		expect((await readEndpoint(path.join(root, "server.json"))).token).toBe(endpoint.token);
		const current = z.object({ instance: z.string(), pid: z.number(), ownership: z.string() }).parse(await readOptionalJson(path.join(root, "server.managed.json")));
		expect(current).toMatchObject({ pid: process.pid, ownership: "existing" });
		expect(current.instance).not.toBe(oldRecord.instance);
	} finally {
		reader.releaseLock();
		if (previous.exitCode === null) previous.stdin.end();
		await previous.exited;
		await replacement?.close();
	}
}, 60000);

test("failed authentication never replaces a live service or signals its PID", async () => {
	const root = await fixture();
	const broker = await startBroker({ stateDir: root });
	try {
		await writePrivateJson(path.join(root, "server.json"), { ...broker.endpoint, token: "wrong-fixture-token" });
		await expect(ensureManagedService({ kind: "server", stateDir: root, packageRoot })).rejects.toMatchObject({ code: "SERVICE_BUSY" });
		expect((await fetch(broker.endpoint.url + "/v1/health", { headers: { authorization: `Bearer ${broker.endpoint.token}` } })).status).toBe(200);
		expect(await readOptionalJson(path.join(root, "server.managed.json"))).toBeUndefined();
	} finally { await broker.close(); }
});

async function localSshFixture(root: string) {
	const data = path.join(root, "plugin data");
	const remoteRoot = path.join(root, "agent state");
	const agentDir = path.join(root, "native agent");
	const ternDir = path.join(root, "native tern");
	const bin = path.join(root, "bin");
	await mkdir(bin); await mkdir(data);
	// This native executable is only a discovery fixture; isolated installation
	// never runs Tern plugin reload or contacts a user's Tern daemon.
	const ternExecutable = path.join(bin, "tern");
	await symlink(process.execPath, ternExecutable);
	// Use the real project-pinned host, as the packaging tests do. The user's
	// independently upgraded global OMP/runtime is not this isolated fixture.
	const ompCli = path.join(packageRoot, "node_modules", "@oh-my-pi", "pi-coding-agent", "dist", "cli.js");
	await writeFile(path.join(bin, "omp"), `#!/bin/sh\nexec ${shellArgument(process.execPath)} ${shellArgument(ompCli)} "$@"\n`, { mode: 0o700 });
	// Transport-only fixture: all remote commands, installers, brokers, relays and signatures are real.
	// It never connects to an SSH host and has no production backend flag or test bypass in src/.
	await writeFile(path.join(bin, "ssh"), `#!/bin/sh
if test "$1" = -V; then printf 'OpenSSH test transport\\n' >&2; exit 0; fi
batch=no
forward=no
strict=no
for arg do
 case "$arg" in BatchMode=yes) batch=yes;; ForwardAgent=no) forward=yes;; StrictHostKeyChecking=yes) strict=yes;; esac
 command=$arg
done
test "$batch:$forward:$strict" = yes:yes:yes || exit 91
exec sh -c "$command"
`, { mode: 0o700 });
	const source = await packageArchive(packageRoot, data, path.join(data, "setup.log"));
	const release = path.join(remoteRoot, "installation", "packages", source.digest);
	await mkdir(release, { recursive: true });
	for (const entry of await packageFiles(packageRoot)) {
		const destination = path.join(release, entry);
		await mkdir(path.dirname(destination), { recursive: true });
		await cp(path.join(packageRoot, entry), destination);
	}
	// Dependencies already installed by the test runner are reused, keeping regression offline.
	await symlink(path.join(packageRoot, "node_modules"), path.join(release, "node_modules"), "dir");
	await writePrivateJson(path.join(release, ".setup-package.json"), { schema: 1, digest: source.digest });
	const home = path.join(root, "remote home");
	await mkdir(home);
	const env = { ...process.env, PATH: [bin, path.dirname(process.execPath), process.env.PATH].join(path.delimiter), HOME: home, TERN_OMP_BRIDGE_HOME: path.join(root, "unused-default-state"), PI_CODING_AGENT_DIR: path.join(root, "unused-default-agent"), TERN_CONFIG_DIR: path.join(root, "unused-default-tern") };
	ownedStates.push({ kind: "server", stateDir: remoteRoot }, { kind: "client", stateDir: path.join(data, "bridge") });
	async function run(clientExecutable?: string, clientSocket?: string) {
		const args = [process.execPath, cli, "setup", "--host", "fixture-host", "--plugin-data", data, "--package-root", packageRoot, "--remote-root", remoteRoot, "--agent-dir", agentDir, "--tern-dir", ternDir];
		if (clientExecutable) args.push("--tern-executable", clientExecutable);
		if (clientSocket) args.push("--tern-pane-socket", clientSocket);
		const child = Bun.spawn(args, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
		const stdout = new Response(child.stdout).text();
		const stderr = new Response(child.stderr).text();
		return { code: await child.exited, stdout: await stdout, stderr: await stderr };
	}
	return { data, remoteRoot, agentDir, ternDir, release, ternExecutable, run };
}

test.skipIf(process.platform === "win32")("first and repeat plugin setup stage real code, preserve identity/config and await an actual OMP session", async () => {
	const fixtureState = await localSshFixture(await fixture());
	await writeFile(path.join(fixtureState.data, "config.json"), JSON.stringify({ preserved: "untouched" }));
	const clientExecutable = path.join(fixtureState.data, "client CLI with spaces");
	await symlink(process.execPath, clientExecutable);
	const clientSocket = path.join(fixtureState.data, "client daemon.sock");
	const firstRun = await fixtureState.run(clientExecutable, clientSocket);
	const failureLog = firstRun.code === 0 ? firstRun.stderr : await readFile(path.join(fixtureState.data, "setup.log"), "utf8").catch(() => firstRun.stderr);
	expect(firstRun.code, failureLog).toBe(0);
	expect(firstRun.stderr).toBe("");
	const first = SetupResultSchema.parse(JSON.parse(firstRun.stdout));
	expect(first).toMatchObject({ status: "awaiting_session", client: { reused: false, ownership: "managed", connected: true, sessionReady: false }, remote: { root: fixtureState.remoteRoot, pluginReload: "isolated", broker: { reused: false } } });
	const firstIdentity = await readFile(path.join(fixtureState.data, "bridge", "identity.json"), "utf8");
	expect(JSON.parse(firstIdentity).device).not.toHaveProperty("capabilities");
	const secondRun = await fixtureState.run();
	expect(secondRun.code).toBe(0);
	const second = SetupResultSchema.parse(JSON.parse(secondRun.stdout));
	expect(second.client).toMatchObject({ reused: true, pid: first.client.pid, deviceId: first.client.deviceId });
	expect(second.remote.broker).toMatchObject({ reused: true, pid: first.remote.broker.pid });
	expect(await readFile(path.join(fixtureState.data, "bridge", "identity.json"), "utf8")).toBe(firstIdentity);
	expect(JSON.parse(await readFile(path.join(fixtureState.data, "config.json"), "utf8"))).toEqual({ preserved: "untouched", controlFile: first.controlFile, ternExecutable: clientExecutable, ternPaneSocket: clientSocket });
	expect(JSON.parse(await readFile(first.remote.ternConfig, "utf8")).ternExecutable).toBe(fixtureState.ternExecutable);
	expect(JSON.parse(await readFile(first.remote.ternConfig, "utf8"))).not.toHaveProperty("ternPaneSocket");
	const progress = SetupProgressSchema.parse(JSON.parse(await readFile(path.join(fixtureState.data, "setup-state.json"), "utf8")));
	expect(progress).toMatchObject({ status: "awaiting_session", controlFile: first.controlFile });
	expect(JSON.stringify(progress)).not.toContain("privateKey");
	expect(first.remote.ompLoader.startsWith(fixtureState.agentDir)).toBe(true);
	expect(first.remote.ternPlugin.startsWith(fixtureState.ternDir)).toBe(true);
}, 180000);

test.skipIf(process.platform === "win32")("failed native installation keeps config untouched and the same setup repairs the partial installation", async () => {
	const fixtureState = await localSshFixture(await fixture());
	const extension = path.join(fixtureState.agentDir, "extensions", "tern-omp-client-bridge");
	await mkdir(extension, { recursive: true });
	await writeFile(path.join(extension, "index.ts"), "// unrelated fixture loader\n");
	await writeFile(path.join(fixtureState.data, "config.json"), JSON.stringify({ preserved: "untouched" }));
	const failed = await fixtureState.run();
	expect(failed.code).not.toBe(0);
	expect(failed.stdout).toBe("");
	expect(JSON.parse(await readFile(path.join(fixtureState.data, "config.json"), "utf8"))).toEqual({ preserved: "untouched" });
	expect(SetupProgressSchema.parse(JSON.parse(await readFile(path.join(fixtureState.data, "setup-state.json"), "utf8"))).status).toBe("failed");
	expect(await readFile(path.join(extension, "index.ts"), "utf8")).toBe("// unrelated fixture loader\n");
	await rm(path.join(extension, "index.ts"));
	const repaired = await fixtureState.run();
	expect(repaired.code).toBe(0);
	expect(SetupResultSchema.parse(JSON.parse(repaired.stdout)).status).toBe("awaiting_session");
}, 180000);

test.skipIf(process.platform === "win32")("a cached release marker cannot hide modified published documentation", async () => {
	const fixtureState = await localSshFixture(await fixture());
	const readme = path.join(fixtureState.release, "README.md");
	expect(await readFile(readme, "utf8")).toBe(await readFile(path.join(packageRoot, "README.md"), "utf8"));
	await writeFile(readme, "Changed after publication; the cached marker is now stale.\n");
	const failed = await fixtureState.run();
	expect(failed.code).not.toBe(0);
	expect(failed.stdout).toBe("");
	expect(await readOptionalJson(path.join(fixtureState.data, "config.json"))).toBeUndefined();
	expect(await readFile(path.join(fixtureState.data, "setup.log"), "utf8")).toContain("source integrity conflict");
	expect(await readFile(readme, "utf8")).toBe("Changed after publication; the cached marker is now stale.\n");
	expect(SetupProgressSchema.parse(JSON.parse(await readFile(path.join(fixtureState.data, "setup-state.json"), "utf8"))).status).toBe("failed");
}, 180000);
