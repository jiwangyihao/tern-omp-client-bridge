// SPDX-License-Identifier: MPL-2.0
import { afterEach, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClientResumePlanSchema, resumeClient, saveClientResumePlan, validateClientResumeLaunch, type ClientResumePlan } from "../../src/client-resume.ts";
import { loadClientIdentity, writePrivateJson } from "../../src/config.ts";
import { ensureManagedService, runManagedService } from "../../src/setup-managed.ts";
import { inspectSetupPackage } from "../../src/setup-payload.ts";
import { readOptionalJson } from "../../src/setup-state.ts";
import { startClientService } from "../../src/client.ts";

const packageRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(aliasedParent = false) {
	const root = await mkdtemp(path.join(os.tmpdir(), "bridge-resume-unit-"));
	roots.push(root);
	let data = root;
	if (aliasedParent) {
		const actual = path.join(root, "actual");
		const alias = path.join(root, "alias");
		await mkdir(actual);
		await symlink(actual, alias, process.platform === "win32" ? "junction" : "dir");
		data = path.join(alias, "plugin-data");
	}
	const stateDir = path.join(data, "bridge");
	const identity = await loadClientIdentity(stateDir);
	const plan: ClientResumePlan = { schema: 1, kind: "client-resume", host: "fixture-host", remoteCommand: "fixture-relay", stateDir, controlFile: path.join(stateDir, "client.json"), packageRoot, runtime: process.execPath, deviceId: identity.device.id, packageDigest: (await inspectSetupPackage(packageRoot)).digest };
	const config = { controlFile: plan.controlFile, preserved: { value: true } };
	await writePrivateJson(path.join(data, "config.json"), config);
	await saveClientResumePlan(data, plan);
	return { data, stateDir, identity, plan, config, planFile: path.join(data, "client-resume.json"), configFile: path.join(data, "config.json"), identityFile: path.join(stateDir, "identity.json") };
}

for (const aliasedParent of [false, true]) test(`automatic package maintenance preserves the revocable connection approval (${aliasedParent ? "parent alias" : "ordinary directory"})`, async () => {
	const f = await fixture(aliasedParent);
	const approval = await readFile(f.planFile, "utf8");
	const identity = await readFile(f.identityFile, "utf8");
	const snapshot = await inspectSetupPackage(packageRoot);
	const prepared = path.join(f.data, "installation", "packages", snapshot.digest);
	await mkdir(prepared, { recursive: true });
	for (const file of snapshot.files) {
		const destination = path.join(prepared, file);
		await mkdir(path.dirname(destination), { recursive: true });
		await cp(path.join(packageRoot, file), destination);
	}
	await symlink(path.join(packageRoot, "node_modules"), path.join(prepared, "node_modules"), process.platform === "win32" ? "junction" : "dir");
	await writePrivateJson(path.join(prepared, ".bridge-installation.json"), { schema: 1, source: snapshot.digest, runtime: `${process.platform}-${process.arch}` });
	const unavailable = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("not ready", { status: 503 }) });
	const client = await startClientService({ identity: f.identity, stateDir: f.stateDir, serverName: f.plan.host, connection: { kind: "loopback", endpoint: { url: `http://127.0.0.1:${unavailable.port}`, token: "synthetic-maintenance-broker" } } });
	try {
		const child = Bun.spawn([process.execPath, path.join(prepared, "src", "cli.ts"), "resume-client", "--plugin-data", f.data], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30000 });
		const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
		expect(code, stderr).toBe(0);
		expect(stderr).toBe("");
		expect(JSON.parse(stdout)).toMatchObject({ kind: "client-resumed", reused: true, connected: false, deviceId: f.identity.device.id });
		expect(await readFile(f.planFile, "utf8")).toBe(approval);
		expect(await readFile(f.identityFile, "utf8")).toBe(identity);
	} finally { await client.close(); await unavailable.stop(true); }
}, 60000);

test("prepared package validation rejects redirected installation cache children", async () => {
	// Real directory aliases exercise native filesystem resolution without changing the saved approval.
	const f = await fixture();
	const outside = await mkdtemp(path.join(os.tmpdir(), "bridge-outside-cache-"));
	roots.push(outside);
	const digest = "b".repeat(64);
	const escaped = path.join(outside, "packages", digest);
	await mkdir(escaped, { recursive: true });
	await writePrivateJson(path.join(escaped, ".bridge-installation.json"), { schema: 1, source: digest, runtime: `${process.platform}-${process.arch}` });
	await symlink(outside, path.join(f.data, "installation"), process.platform === "win32" ? "junction" : "dir");
	const approval = await readFile(f.planFile, "utf8");
	await expect(validateClientResumeLaunch({ kind: "client", stateDir: f.stateDir, packageRoot: path.join(f.data, "installation", "packages", digest), host: f.plan.host, remoteCommand: f.plan.remoteCommand, expectedDeviceId: f.plan.deviceId, expectedPackageDigest: digest, expectedResumeDigest: new Bun.CryptoHasher("sha256").update(JSON.stringify(f.plan)).digest("hex"), resumePluginData: f.data })).rejects.toMatchObject({ code: "CLIENT_RESUME_PACKAGE_CONFLICT" });
	expect(await readFile(f.planFile, "utf8")).toBe(approval);
	expect(await readOptionalJson(f.plan.controlFile)).toBeUndefined();
	expect(await readOptionalJson(path.join(f.stateDir, "client.managed.json"))).toBeUndefined();
}, 60000);

test("recovery without consented receipt fails before provisioning any local identity", async () => {
	const data = await mkdtemp(path.join(os.tmpdir(), "bridge-resume-unapproved-"));
	roots.push(data);
	await writePrivateJson(path.join(data, "config.json"), { controlFile: path.join(data, "bridge", "client.json") });
	await expect(resumeClient(data)).rejects.toMatchObject({ code: "CLIENT_RESUME_SETUP_REQUIRED" });
	expect(await readOptionalJson(path.join(data, "bridge", "identity.json"))).toBeUndefined();
	expect(await readOptionalJson(path.join(data, "client-resume.json"))).toBeUndefined();
});

test("only an exact bounded nonsecret recovery plan is accepted", async () => {
	const { plan } = await fixture();
	expect(ClientResumePlanSchema.safeParse(plan).success).toBe(true);
	for (const patch of [
		{ schema: 2 }, { kind: "client" }, { controlFile: path.join(plan.stateDir, "server.json") },
		{ stateDir: "relative" }, { packageRoot: "relative" }, { runtime: "bun" }, { deviceId: "not-a-key-id" },
		{ packageDigest: "changed" }, { token: "must-not-be-saved" }, { remoteCommand: "relay\nextra" },
	]) expect(ClientResumePlanSchema.safeParse({ ...plan, ...patch }).success).toBe(false);
});

test("changed or missing config and changed plan never start or rewrite the approved client", async () => {
	const f = await fixture();
	const identity = await readFile(f.identityFile, "utf8");
	for (const patch of [
		{ schema: 2 }, { controlFile: path.join(f.data, "different", "client.json") },
		{ runtime: path.join(f.data, "different-bun") }, { packageRoot: path.join(f.data, "different-package") },
		{ packageDigest: "0".repeat(64) },
	]) {
		await writePrivateJson(f.planFile, { ...f.plan, ...patch });
		await expect(resumeClient(f.data)).rejects.toBeDefined();
		expect(await readOptionalJson(f.plan.controlFile)).toBeUndefined();
		expect(await readOptionalJson(path.join(f.stateDir, "client.managed.json"))).toBeUndefined();
		expect(await readFile(f.identityFile, "utf8")).toBe(identity);
	}
	await writePrivateJson(f.planFile, f.plan);
	await writePrivateJson(f.configFile, { ...f.config, controlFile: path.join(f.data, "other", "client.json") });
	await expect(resumeClient(f.data)).rejects.toMatchObject({ code: "CLIENT_RESUME_CONFIG_CONFLICT" });
	await rm(f.configFile);
	await expect(resumeClient(f.data)).rejects.toMatchObject({ code: "CLIENT_RESUME_CONFIG_CONFLICT" });
	expect(await readOptionalJson(f.configFile)).toBeUndefined();
	await writePrivateJson(f.configFile, f.config);
	await writeFile(f.planFile, "{broken private metadata");
	await expect(resumeClient(f.data)).rejects.toBeDefined();
	expect(await readFile(f.identityFile, "utf8")).toBe(identity);
	expect(await readOptionalJson(f.plan.controlFile)).toBeUndefined();
}, 30000);

test("recovery refuses missing, replaced and malformed identities without writing them", async () => {
	const f = await fixture();
	await rm(f.identityFile);
	await expect(resumeClient(f.data)).rejects.toMatchObject({ code: "CLIENT_IDENTITY_REQUIRED" });
	expect(await readOptionalJson(f.identityFile)).toBeUndefined();
	const other = await fixture();
	await writePrivateJson(f.identityFile, other.identity);
	const replaced = await readFile(f.identityFile, "utf8");
	await expect(resumeClient(f.data)).rejects.toMatchObject({ code: "CLIENT_IDENTITY_CONFLICT" });
	expect(await readFile(f.identityFile, "utf8")).toBe(replaced);
	await writePrivateJson(f.identityFile, { ...f.identity, privateKey: other.identity.privateKey });
	const invalid = await readFile(f.identityFile, "utf8");
	await expect(resumeClient(f.data)).rejects.toMatchObject({ code: "INVALID_IDENTITY" });
	expect(await readFile(f.identityFile, "utf8")).toBe(invalid);
	expect(await readOptionalJson(f.plan.controlFile)).toBeUndefined();
}, 30000);

test.skipIf(process.platform === "win32")("symlink approvals and identities are not followed during recovery", async () => {
	const f = await fixture();
	const savedPlan = path.join(f.data, "saved-plan.json");
	await writePrivateJson(savedPlan, f.plan);
	await rm(f.planFile);
	await symlink(savedPlan, f.planFile);
	await expect(resumeClient(f.data)).rejects.toMatchObject({ code: "SETUP_CONFLICT" });
	await rm(f.planFile);
	await writePrivateJson(f.planFile, f.plan);
	const savedIdentity = path.join(f.data, "saved-identity.json");
	await writePrivateJson(savedIdentity, f.identity);
	await rm(f.identityFile);
	await symlink(savedIdentity, f.identityFile);
	await expect(resumeClient(f.data)).rejects.toMatchObject({ code: "INVALID_IDENTITY" });
	expect(await readOptionalJson(f.plan.controlFile)).toBeUndefined();
});

test("launcher and detached lifecycle both refuse identity deletion after prior validation", async () => {
	const f = await fixture();
	const options = { kind: "client" as const, stateDir: f.stateDir, packageRoot, host: f.plan.host, remoteCommand: f.plan.remoteCommand, expectedDeviceId: f.plan.deviceId, expectedPackageDigest: f.plan.packageDigest };
	await loadClientIdentity(f.stateDir, { expectedDeviceId: f.plan.deviceId });
	await rm(f.identityFile);
	await expect(ensureManagedService(options)).rejects.toMatchObject({ code: "CLIENT_IDENTITY_REQUIRED" });
	await expect(runManagedService(options)).rejects.toMatchObject({ code: "CLIENT_IDENTITY_REQUIRED" });
	expect(await readOptionalJson(f.identityFile)).toBeUndefined();
	expect(await readOptionalJson(f.plan.controlFile)).toBeUndefined();
	expect(await readOptionalJson(path.join(f.stateDir, "client.managed.json"))).toBeUndefined();
	expect(await readOptionalJson(path.join(f.stateDir, "client.service.lock"))).toBeUndefined();
	const other = await fixture();
	await writePrivateJson(f.identityFile, other.identity);
	const replaced = await readFile(f.identityFile, "utf8");
	await expect(ensureManagedService(options)).rejects.toMatchObject({ code: "CLIENT_IDENTITY_CONFLICT" });
	await expect(runManagedService(options)).rejects.toMatchObject({ code: "CLIENT_IDENTITY_CONFLICT" });
	expect(await readFile(f.identityFile, "utf8")).toBe(replaced);
	expect(await readOptionalJson(f.plan.controlFile)).toBeUndefined();
}, 30000);

test("detached lifecycle rechecks the approved package before starting a listener", async () => {
	const f = await fixture();
	await expect(runManagedService({ kind: "client", stateDir: f.stateDir, packageRoot, host: f.plan.host, remoteCommand: f.plan.remoteCommand, expectedDeviceId: f.plan.deviceId, expectedPackageDigest: "0".repeat(64) })).rejects.toMatchObject({ code: "CLIENT_RESUME_PACKAGE_CONFLICT" });
	expect(await readOptionalJson(f.plan.controlFile)).toBeUndefined();
	expect(await readOptionalJson(path.join(f.stateDir, "client.managed.json"))).toBeUndefined();
});

test("detached recovery refuses approval revoked or changed after launcher admission", async () => {
	const f = await fixture();
	const options = { kind: "client" as const, stateDir: f.stateDir, packageRoot, host: f.plan.host, remoteCommand: f.plan.remoteCommand, expectedDeviceId: f.plan.deviceId, expectedPackageDigest: f.plan.packageDigest, resumePluginData: f.data };
	const identity = await readFile(f.identityFile, "utf8");
	await validateClientResumeLaunch(options);
	await rm(f.planFile);
	await expect(runManagedService(options)).rejects.toMatchObject({ code: "CLIENT_RESUME_SETUP_REQUIRED" });
	expect(await readOptionalJson(f.planFile)).toBeUndefined();
	for (const patch of [
		{ host: "changed-host" }, { remoteCommand: "changed-relay" },
		{ stateDir: f.data, controlFile: path.join(f.data, "client.json") },
		{ packageRoot: f.data }, { runtime: path.join(f.data, "different-runtime") },
		{ deviceId: "client_" + "0".repeat(32) }, { packageDigest: "0".repeat(64) },
	]) {
		await writePrivateJson(f.planFile, f.plan);
		await validateClientResumeLaunch(options);
		await writePrivateJson(f.planFile, { ...f.plan, ...patch });
		const changed = await readFile(f.planFile, "utf8");
		await expect(runManagedService(options)).rejects.toMatchObject({ code: "CLIENT_RESUME_CONFLICT" });
		expect(await readFile(f.planFile, "utf8")).toBe(changed);
		expect(await readOptionalJson(f.plan.controlFile)).toBeUndefined();
		expect(await readOptionalJson(path.join(f.stateDir, "client.managed.json"))).toBeUndefined();
	}
	await writePrivateJson(f.planFile, f.plan);
	await validateClientResumeLaunch(options);
	await writePrivateJson(f.configFile, { controlFile: path.join(f.data, "other", "client.json") });
	await expect(runManagedService(options)).rejects.toMatchObject({ code: "CLIENT_RESUME_CONFIG_CONFLICT" });
	await rm(f.configFile);
	await expect(runManagedService(options)).rejects.toMatchObject({ code: "CLIENT_RESUME_CONFIG_CONFLICT" });
	expect(await readOptionalJson(f.configFile)).toBeUndefined();
	expect(await readFile(f.identityFile, "utf8")).toBe(identity);
	expect(await readOptionalJson(f.planFile)).toEqual(f.plan);
	expect(await readOptionalJson(f.plan.controlFile)).toBeUndefined();
	expect(await readOptionalJson(path.join(f.stateDir, "client.service.lock"))).toBeUndefined();
}, 30000);

test("detached CLI rejects deleted or changed approval after launcher validation", async () => {
	const f = await fixture();
	const options = { kind: "client" as const, stateDir: f.stateDir, packageRoot, host: f.plan.host, remoteCommand: f.plan.remoteCommand, expectedDeviceId: f.plan.deviceId, expectedPackageDigest: f.plan.packageDigest, resumePluginData: f.data };
	const identity = await readFile(f.identityFile, "utf8");
	const args = [process.execPath, path.join(packageRoot, "src", "cli.ts"), "managed-service", "--kind", "client", "--state-dir", f.stateDir, "--package-root", packageRoot, "--host", f.plan.host, "--remote-command", f.plan.remoteCommand, "--expected-device-id", f.plan.deviceId, "--expected-package-digest", f.plan.packageDigest, "--resume-plugin-data", f.data];
	for (const revoke of ["delete", "change"] as const) {
		await writePrivateJson(f.planFile, f.plan);
		await validateClientResumeLaunch(options);
		if (revoke === "delete") await rm(f.planFile);
		else await writePrivateJson(f.planFile, { ...f.plan, remoteCommand: "changed-after-launcher-validation" });
		const approved = await readOptionalJson(f.planFile);
		const child = Bun.spawn(args, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
		const stdout = new Response(child.stdout).text();
		const stderr = new Response(child.stderr).text();
		expect(await child.exited).not.toBe(0);
		expect(await stdout).toBe("");
		expect(await stderr).toContain(revoke === "delete" ? "CLIENT_RESUME_SETUP_REQUIRED" : "CLIENT_RESUME_CONFLICT");
		expect(await readOptionalJson(f.planFile)).toEqual(approved);
		expect(await readFile(f.identityFile, "utf8")).toBe(identity);
		expect(await readOptionalJson(f.plan.controlFile)).toBeUndefined();
		expect(await readOptionalJson(path.join(f.stateDir, "client.managed.json"))).toBeUndefined();
		expect(await readOptionalJson(path.join(f.stateDir, "client.service.lock"))).toBeUndefined();
	}
}, 15000);
