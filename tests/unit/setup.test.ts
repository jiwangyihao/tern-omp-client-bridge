// SPDX-License-Identifier: MPL-2.0
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadClientIdentity, signIdentity, verifyIdentity, writePrivateJson } from "../../src/config.ts";
import { setupIdentity } from "../../src/setup-managed.ts";
import { remotePath, setupCommand, shellArgument, sshCommand, validateHost } from "../../src/setup-remote.ts";
import { acquireSetupLock, mergeControlFile, readOptionalJson, SetupProgressSchema, writeSetupProgress } from "../../src/setup-state.ts";

const roots: string[] = [];
async function fixture(): Promise<string> {
	const root = await mkdtemp(path.join(os.tmpdir(), "tern-bridge-setup-unit-"));
	roots.push(root);
	return root;
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test("setup lock is single-flight and a released owner cannot remove another lock", async () => {
	const root = await fixture();
	const file = path.join(root, "setup.lock");
	const release = await acquireSetupLock(file);
	await expect(acquireSetupLock(file)).rejects.toMatchObject({ code: "SETUP_BUSY" });
	await release();
	const next = await acquireSetupLock(file);
	await release();
	expect(await readOptionalJson(file)).toBeDefined();
	await next();
	expect(await readOptionalJson(file)).toBeUndefined();
});

test("dead setup owners are recovered without signalling any recorded PID", async () => {
	const root = await fixture();
	const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"], { stdout: "ignore", stderr: "ignore" });
	await child.exited;
	const file = path.join(root, "setup.lock");
	await writePrivateJson(file, { schema: 1, pid: child.pid, instance: crypto.randomUUID() });
	const release = await acquireSetupLock(file);
	expect(await readOptionalJson(file)).toMatchObject({ pid: process.pid });
	await release();
});

test("setup creates an identity without grants and preserves its keys and device ID", async () => {
	const root = await fixture();
	const first = await setupIdentity(root);
	expect(first.device).not.toHaveProperty("capabilities");
	const renamed = await loadClientIdentity(root, { name: "Existing device" });
	const repaired = await setupIdentity(root);
	expect(repaired.privateKey).toBe(first.privateKey);
	expect(repaired.publicKey).toBe(first.publicKey);
	expect(repaired.device.id).toBe(first.device.id);
	expect(repaired.device).toEqual(renamed.device);
});

test.each([{ capabilities: [] }, { capabilities: ["files", "exec", "browser"] }])("legacy identity migration strips grants without rotating identity (%j)", async ({ capabilities }) => {
	const root = await fixture();
	const original = await loadClientIdentity(root, { name: "Existing device" });
	const file = path.join(root, "identity.json");
	await writePrivateJson(file, { ...original, device: { ...original.device, capabilities } });
	const migrated = await setupIdentity(root);
	expect(migrated).toEqual(original);
	expect(JSON.parse(await readFile(file, "utf8"))).toEqual(original);
	expect(verifyIdentity("migration", migrated.device, migrated.publicKey, signIdentity("migration", migrated))).toBe(true);
});

test("progress is bounded atomic public JSON and config merging preserves unrelated values", async () => {
	const root = await fixture();
	await writeFile(path.join(root, "config.json"), JSON.stringify({ theme: "existing", nested: { retained: true }, controlFile: "old" }));
	await writeSetupProgress(root, { status: "installing", stage: "checking-ssh", message: "Checking trusted SSH", host: "fixture-host" });
	const progress = SetupProgressSchema.parse(JSON.parse(await readFile(path.join(root, "setup-state.json"), "utf8")));
	expect(progress.schema).toBe(1);
	expect(progress).not.toHaveProperty("token");
	expect(progress).not.toHaveProperty("privateKey");
	await expect(writeSetupProgress(root, { status: "failed", stage: "failed", message: "x".repeat(1025) })).rejects.toThrow();
	expect(JSON.parse(await readFile(path.join(root, "setup-state.json"), "utf8"))).toEqual(progress);
	const controlFile = path.join(root, "bridge", "client.json");
	const ternPaneSocket = path.join(root, "native daemon.sock");
	await mergeControlFile(root, controlFile, process.execPath, ternPaneSocket);
	expect(JSON.parse(await readFile(path.join(root, "config.json"), "utf8"))).toEqual({ theme: "existing", nested: { retained: true }, controlFile, ternExecutable: process.execPath, ternPaneSocket });
	if (process.platform !== "win32") expect((await stat(path.join(root, "setup-state.json"))).mode & 0o777).toBe(0o600);
});

test("trusted SSH argv never accepts host flags and POSIX directory overrides are explicit", () => {
	for (const host of ["-oProxyCommand=anything", "two hosts", "host\ncommand", ""]) expect(() => validateHost(host)).toThrow();
	const args = sshCommand("fixture-host", ["sh", "-c", "printf '%s' \"$1\"", "bridge", "/tmp/a 'quoted' directory; $HOME"]);
	expect(args).toContain("BatchMode=yes");
	expect(args).toContain("ForwardAgent=no");
	expect(args).toContain("StrictHostKeyChecking=yes");
	expect(args).not.toContain("StrictHostKeyChecking=no");
	expect(args.at(-2)).toBe("fixture-host");
	for (const value of ["/", "///", "/./", "~/state", "relative", "/tmp/../home", "/tmp/line\nbreak"]) expect(() => remotePath(value)).toThrow();
	expect(remotePath("/tmp/bridge space")).toBe("/tmp/bridge space");
});

test.skipIf(process.platform === "win32")("SSH argument quoting keeps command substitutions and quotes literal", async () => {
	const root = await fixture();
	const value = "a 'quote'; $(printf injected) \"double\"";
	const result = await setupCommand("sh", ["-c", ["printf", "%s", value].map(shellArgument).join(" ")], { log: path.join(root, "setup.log"), message: "Failed fixture command" });
	expect(result).toBe(value);
});

test("private command logs do not appear in actionable public failures", async () => {
	const root = await fixture();
	const log = path.join(root, "setup.log");
	await expect(setupCommand(process.execPath, ["-e", "console.error('private-fixture-marker');process.exit(4)"], { log, message: "Check trusted SSH access and retry." })).rejects.toMatchObject({ message: "Check trusted SSH access and retry." });
	expect(await readFile(log, "utf8")).toContain("private-fixture-marker");
});
