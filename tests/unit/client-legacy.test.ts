// SPDX-License-Identifier: MPL-2.0
import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packageFiles } from "../../scripts/build.ts";
import { inspectLegacyClientInstallation } from "../../src/client-legacy.ts";
import { resumeClient } from "../../src/client-resume.ts";
import { loadClientIdentity, writePrivateJson } from "../../src/config.ts";
import { inspectSetupPackage } from "../../src/setup-payload.ts";
import { readOptionalJson } from "../../src/setup-state.ts";

const source = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

test("verified legacy installation stays read-only and cannot override later recovery revocation", async () => {
	// Native Windows ACL writes are real subprocesses; this is not a fake-clock test.
	const root = await mkdtemp(path.join(os.tmpdir(), "bridge-legacy-evidence-"));
	try {
		const data = path.join(root, "plugin data");
		const stateDir = path.join(root, "client state");
		const controlFile = path.join(stateDir, "client.json");
		const identity = await loadClientIdentity(stateDir, { name: "Synthetic legacy client" });
		const identityFile = path.join(stateDir, "identity.json");
		const before = await readFile(identityFile, "utf8");
		const stage = path.join(root, "legacy source");
		for (const file of await packageFiles(source)) {
			const destination = path.join(stage, file);
			await mkdir(path.dirname(destination), { recursive: true });
			await cp(path.join(source, file), destination);
		}
		const metadata = JSON.parse(await readFile(path.join(stage, "package.json"), "utf8"));
		await writeFile(path.join(stage, "package.json"), JSON.stringify({ ...metadata, version: "0.5.0-beta.3" }) + "\n");
		const manifest = await readFile(path.join(stage, "plugin.toml"), "utf8");
		await writeFile(path.join(stage, "plugin.toml"), manifest.replace(/^version = .*$/m, 'version = "0.5.0-beta.3"'));
		const snapshot = await inspectSetupPackage(stage);
		const packageRoot = path.join(data, "installation", "packages", snapshot.digest);
		await mkdir(path.dirname(packageRoot), { recursive: true });
		await rename(stage, packageRoot);
		await writePrivateJson(path.join(packageRoot, ".bridge-installation.json"), { schema: 1, source: snapshot.digest, runtime: `${process.platform}-${process.arch}` });
		await writePrivateJson(path.join(data, "installation", "current.json"), { schema: 1, packageRoot, fingerprint: snapshot.digest });
		await writePrivateJson(path.join(data, "config.json"), { controlFile });
		await writePrivateJson(path.join(data, "setup-state.json"), { schema: 1, status: "awaiting_session", host: "legacy.invalid", controlFile, updatedAt: 1 });
		const dead = Bun.spawn([process.execPath, "-e", "process.exit(0)"], { stdout: "ignore", stderr: "ignore" });
		await dead.exited;
		await writePrivateJson(path.join(stateDir, "client.managed.json"), { schema: 1, kind: "client", ownership: "managed", pid: dead.pid, instance: crypto.randomUUID(), host: "legacy.invalid", packageRoot, runtime: process.execPath, packageDigest: snapshot.digest });
		const evidence = await inspectLegacyClientInstallation(data);
		expect(evidence).toMatchObject({ deviceId: identity.device.id, controlFile, packageRoot, packageDigest: snapshot.digest });
		expect(await readFile(identityFile, "utf8")).toBe(before);
		expect(await readOptionalJson(path.join(data, "client-resume.json"))).toBeUndefined();
		const document = path.join(packageRoot, "README.md");
		const original = await readFile(document);
		await writeFile(document, "Modified after the earlier installation.\n");
		await expect(inspectLegacyClientInstallation(data)).rejects.toMatchObject({ code: "CLIENT_RESUME_PACKAGE_CONFLICT" });
		await writeFile(document, original);
		await writePrivateJson(path.join(data, "client-resume-initialized.json"), { schema: 1 });
		await expect(resumeClient(data)).rejects.toMatchObject({ code: "CLIENT_RESUME_SETUP_REQUIRED" });
		expect(await readOptionalJson(path.join(data, "client-resume.json"))).toBeUndefined();
		expect(await readOptionalJson(controlFile)).toBeUndefined();
		expect(await readFile(identityFile, "utf8")).toBe(before);
	} finally { await rm(root, { recursive: true, force: true }); }
}, 60000);
