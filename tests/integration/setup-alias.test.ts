// SPDX-License-Identifier: MPL-2.0
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startBroker } from "../../src/broker.ts";
import { BrokerClient } from "../../src/broker-client.ts";
import { startClientService } from "../../src/client.ts";
import { saveClientResumePlan } from "../../src/client-resume.ts";
import { loadClientIdentity, writePrivateJson } from "../../src/config.ts";
import { LocalUiStateSchema } from "../../src/schemas.ts";
import { admitExistingClientRoute, approvedBrokerRoot, proveSameBroker, readBrokerIdentity, saveSetupClientResumePlan } from "../../src/setup-alias.ts";
import { ensureManagedService, serviceHealth } from "../../src/setup-managed.ts";
import { inspectSetupPackage } from "../../src/setup-payload.ts";
import { shellArgument } from "../../src/setup-remote.ts";

const packageRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture() {
	const root = await mkdtemp(path.join(os.tmpdir(), "bridge-alias-"));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const serverDir = path.join(root, "broker");
	const stateDir = path.join(root, "client");
	const broker = await startBroker({ stateDir: serverDir });
	cleanup.push(() => broker.close());
	const identity = await loadClientIdentity(stateDir);
	const client = await startClientService({ stateDir, identity, serverName: "original", connection: { kind: "loopback", endpoint: broker.endpoint } });
	cleanup.push(() => client.close());
	await client.waitForConnection(AbortSignal.timeout(10000));
	const digest = (await inspectSetupPackage(packageRoot)).digest;
	const plan = { schema: 1 as const, kind: "client-resume" as const, host: "original", remoteCommand: ["/usr/bin/bun", "/bridge/src/cli.ts", "relay", "--state-dir", "/fixture/broker"].map(shellArgument).join(" "), stateDir, controlFile: path.join(stateDir, "client.json"), packageRoot, runtime: process.execPath, deviceId: identity.device.id, packageDigest: digest };
	await writePrivateJson(path.join(root, "config.json"), { controlFile: plan.controlFile });
	await saveClientResumePlan(root, plan);
	await writePrivateJson(path.join(stateDir, "client.managed.json"), { schema: 1, kind: "client", pid: process.pid, instance: crypto.randomUUID(), ownership: "managed", host: plan.host, packageRoot, runtime: process.execPath, packageDigest: digest });
	const probe = async (host: string, remoteRoot: string, deviceId: string) => {
		if (host !== "original" && host !== "alias") throw Error("Untrusted fixture route");
		return readBrokerIdentity(remoteRoot === "/fixture/broker" ? serverDir : remoteRoot, deviceId, packageRoot);
	};
	const options = { pluginData: root, stateDir, host: "alias", remoteRoot: serverDir, log: path.join(root, "setup.log") };
	return { root, serverDir, stateDir, broker, client, identity, plan, options, probe };
}

test("same-broker SSH names reuse one real connection and preserve the exact recovery grant", async () => {
	const f = await fixture();
	const grantFile = path.join(f.root, "client-resume.json");
	// Noncanonical whitespace makes accidental parse-and-rewrite detectable too.
	await writeFile(grantFile, JSON.stringify(f.plan, null, 4) + "\n\n");
	const before = await readFile(grantFile, "utf8");
	const recordBefore = await readFile(path.join(f.stateDir, "client.managed.json"), "utf8");
	const route = await admitExistingClientRoute(f.options, f.probe);
	expect(route?.plan?.host).toBe("original");
	const result = await ensureManagedService({ kind: "client", stateDir: f.stateDir, packageRoot, host: route!.plan!.host, remoteCommand: route!.plan!.remoteCommand, verifyExistingClient: route!.verify });
	expect(result).toMatchObject({ reused: true, pid: process.pid, connected: true, deviceId: f.identity.device.id });
	await saveSetupClientResumePlan(f.root, { ...f.plan, host: "alias", remoteCommand: "not the original relay" }, route);
	expect(await readFile(grantFile, "utf8")).toBe(before);
	expect(await readFile(path.join(f.stateDir, "client.managed.json"), "utf8")).toBe(recordBefore);
	expect((await serviceHealth("client", f.stateDir)).endpoint).toEqual(f.client.endpoint);
	expect(await loadClientIdentity(f.stateDir)).toEqual(f.identity);
}, 30000);

test("another real broker with the same signed device is not an alias", async () => {
	const f = await fixture();
	const otherRoot = path.join(f.root, "other-broker");
	const other = await startBroker({ stateDir: otherRoot });
	cleanup.push(() => other.close());
	const otherClient = await startClientService({ stateDir: path.join(f.root, "other-client"), identity: f.identity, serverName: "original", connection: { kind: "loopback", endpoint: other.endpoint } });
	cleanup.push(() => otherClient.close());
	await otherClient.waitForConnection(AbortSignal.timeout(10000));
	const grant = await readFile(path.join(f.root, "client-resume.json"), "utf8");
	await expect(admitExistingClientRoute({ ...f.options, remoteRoot: otherRoot }, f.probe)).rejects.toMatchObject({ code: "SERVICE_HOST_CONFLICT" });
	expect(await readFile(path.join(f.root, "client-resume.json"), "utf8")).toBe(grant);
	expect((await serviceHealth("client", f.stateDir)).connected).toBe(true);
}, 30000);

test("legacy state requires original-route live proof, not matching names or device IDs", async () => {
	const f = await fixture();
	const health = { ...await serviceHealth("client", f.stateDir), serverInstance: undefined };
	const original = await readBrokerIdentity(f.serverDir, f.identity.device.id, packageRoot);
	const candidate = await f.probe("alias", f.serverDir, f.identity.device.id);
	expect(() => proveSameBroker(health, candidate)).toThrow("legacy client");
	expect(() => proveSameBroker(health, candidate, original)).not.toThrow();
	const otherRoot = path.join(f.root, "other-broker");
	const other = await startBroker({ stateDir: otherRoot });
	cleanup.push(() => other.close());
	const otherClient = await startClientService({ stateDir: path.join(f.root, "other-client"), identity: f.identity, serverName: "original", connection: { kind: "loopback", endpoint: other.endpoint } });
	cleanup.push(() => otherClient.close());
	await otherClient.waitForConnection(AbortSignal.timeout(10000));
	const different = await readBrokerIdentity(otherRoot, f.identity.device.id, packageRoot);
	expect(() => proveSameBroker(health, different, original)).toThrow("different live brokers");
}, 30000);

test("missing proof and revoked grant fail closed without changing the connection", async () => {
	const f = await fixture();
	const route = await admitExistingClientRoute(f.options, f.probe);
	await expect(admitExistingClientRoute({ ...f.options, remoteRoot: path.join(f.root, "missing") }, f.probe)).rejects.toMatchObject({ code: "SERVICE_HOST_UNPROVEN" });
	await rm(path.join(f.root, "client-resume.json"));
	await expect(route!.verify(await serviceHealth("client", f.stateDir))).rejects.toMatchObject({ code: "SERVICE_HOST_UNPROVEN" });
	await expect(admitExistingClientRoute(f.options, f.probe)).rejects.toMatchObject({ code: "SERVICE_HOST_UNPROVEN" });
	expect((await serviceHealth("client", f.stateDir)).endpoint).toEqual(f.client.endpoint);
}, 30000);

test("the original client disappearing after preflight never launches an alias replacement", async () => {
	const f = await fixture();
	const route = await admitExistingClientRoute(f.options, f.probe);
	await f.client.close();
	await expect(ensureManagedService({ kind: "client", stateDir: f.stateDir, packageRoot, host: f.plan.host, remoteCommand: f.plan.remoteCommand, verifyExistingClient: route!.verify })).rejects.toMatchObject({ code: "SERVICE_HOST_UNPROVEN" });
}, 30000);

test("broker proof executes read-only in the previously installed runtime", async () => {
	const f = await fixture();
	const script = `(${readBrokerIdentity.toString()})(${JSON.stringify(f.serverDir)},${JSON.stringify(f.identity.device.id)},${JSON.stringify(packageRoot)}).then(value => console.log(JSON.stringify(value)));`;
	const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
	const output = new Response(child.stdout).text();
	const diagnostics = new Response(child.stderr).text();
	expect(await child.exited).toBe(0);
	expect(await diagnostics).toBe("");
	const proof = JSON.parse(await output);
	expect(proof.instance).toBe((await serviceHealth("client", f.stateDir)).serverInstance);
	expect(proof.registered).toBe(true);
	expect(await output).not.toContain(f.broker.endpoint.token);
	expect((await serviceHealth("client", f.stateDir)).connected).toBe(true);
}, 30000);

test("saved relay parsing handles quoted paths without executing shell expressions", () => {
	const root = "/private/broker's state";
	const command = ["/bin/bun", "/private/package's src/cli.ts", "relay", "--state-dir", root].map(shellArgument).join(" ");
	expect(approvedBrokerRoot(command)).toBe(root);
	expect(approvedBrokerRoot("/root/runtime/bun /root/package/src/cli.ts relay --state-dir /root/state")).toBe("/root/state");
	expect(approvedBrokerRoot(`/bin/bun /pkg/cli.ts relay --state-dir '/private/broker'"'"'s state'`)).toBe(root);
	expect(() => approvedBrokerRoot('/bin/bun /pkg/cli.ts relay --state-dir "$HOME/state"')).toThrow();
	expect(() => approvedBrokerRoot('/bin/bun /pkg/cli.ts relay --state-dir $(pwd)')).toThrow();
	expect(() => approvedBrokerRoot(command + "; echo compromised")).toThrow();
	expect(() => approvedBrokerRoot("bun cli.ts relay --state-dir /tmp")).toThrow();
});

test("legacy authenticated state without instance uses the original approved SSH route", async () => {
	const f = await fixture();
	// Forward a real signed client's authenticated state, omitting only the field absent in beta.4.
	const legacy = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
		const response = await fetch(f.client.endpoint.url + "/v1/state", { headers: request.headers });
		if (!response.ok) return response;
		const state = LocalUiStateSchema.parse(await response.json());
		delete state.serverInstance;
		return Response.json(state);
	} });
	cleanup.push(async () => { legacy.stop(true); });
	await writePrivateJson(f.plan.controlFile, { ...f.client.endpoint, url: `http://127.0.0.1:${legacy.port}` });
	const calls: string[] = [];
	const probe = async (host: string, root: string, deviceId: string) => { calls.push(host); return f.probe(host, root, deviceId); };
	const route = await admitExistingClientRoute(f.options, probe);
	expect(calls).toEqual(["alias", "original"]);
	expect(route?.plan).toEqual(f.plan);
	const originalUnavailable = async (host: string, root: string, deviceId: string) => {
		if (host === "original") throw Error("Original SSH route unavailable");
		return f.probe(host, root, deviceId);
	};
	await expect(admitExistingClientRoute(f.options, originalUnavailable)).rejects.toMatchObject({ code: "SERVICE_HOST_UNPROVEN" });
	expect((await serviceHealth("client", f.stateDir)).connected).toBe(true);
}, 30000);

test("beta.4 without a recovery grant reuses authenticated view identity without creating alias approval", async () => {
	const f = await fixture();
	await rm(path.join(f.root, "client-resume.json"));
	await rm(path.join(f.root, "client-resume-initialized.json"));
	const api = new BrokerClient({ endpoint: f.broker.endpoint });
	cleanup.push(async () => { api.close(); });
	const destinationReady = Promise.withResolvers<{ id: string }>();
	const claimed = Promise.withResolvers<void>();
	api.openDraft("legacy-alias-session", "legacy-alias-draft", {
		onDestination: value => { if (value) destinationReady.resolve(value); },
		onIntent: intent => { void api.claimIntent(intent.id, intent.sessionId, intent.draftToken, intent.destinationId).then(() => api.finishIntent(intent.id)).then(claimed.resolve, claimed.reject); },
		onError: error => { destinationReady.reject(error); claimed.reject(error); },
	});
	const destination = await destinationReady.promise;
	const response = await fetch(f.client.endpoint.url + "/v1/intents", { method: "POST", headers: { authorization: `Bearer ${f.client.endpoint.token}`, "content-type": "application/json" }, body: JSON.stringify({ kind: "resolve", viewId: "legacy-alias-pane", destinationId: destination.id }) });
	expect(response.ok).toBe(true);
	await response.json();
	await claimed.promise;
	const legacy = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
		const response = await fetch(f.client.endpoint.url + "/v1/state", { headers: request.headers });
		if (!response.ok) return response;
		const state = LocalUiStateSchema.parse(await response.json());
		delete state.serverInstance;
		return Response.json(state);
	} });
	cleanup.push(async () => { legacy.stop(true); });
	await writePrivateJson(f.plan.controlFile, { ...f.client.endpoint, url: `http://127.0.0.1:${legacy.port}` });
	// Real broker WebSocket delivery requires platform IO; advancing fake timers cannot deliver it.
	const deadline = Date.now() + 5000;
	let health = await serviceHealth("client", f.stateDir);
	while (!health.sessionReady && Date.now() < deadline) { await Bun.sleep(20); health = await serviceHealth("client", f.stateDir); }
	expect(health.sessionReady).toBe(true);
	const route = await admitExistingClientRoute(f.options, f.probe);
	expect(route).toMatchObject({ host: "original", preserveApproval: true });
	expect(route?.plan).toBeUndefined();
	const retained = await ensureManagedService({ kind: "client", stateDir: f.stateDir, packageRoot, host: route!.host, verifyExistingClient: route!.verify });
	expect(retained).toMatchObject({ reused: true, connected: true, pid: process.pid });
	await saveSetupClientResumePlan(f.root, { ...f.plan, host: "alias" }, route);
	await expect(readFile(path.join(f.root, "client-resume.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	expect((await serviceHealth("client", f.stateDir)).connected).toBe(true);
}, 30000);
