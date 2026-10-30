// SPDX-License-Identifier: MPL-2.0
import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";

const run = promisify(execFile);
const config = fileURLToPath(new URL("../../src/config.ts", import.meta.url));
const bootstrap = fileURLToPath(new URL("../../scripts/bootstrap.ps1", import.meta.url));
const Acl = z.object({ owner: z.string(), current: z.string(), protected: z.boolean(), rules: z.array(z.object({ sid: z.string(), inherited: z.boolean(), rights: z.number(), inheritance: z.number(), propagation: z.number(), allow: z.boolean() })) });

async function acl(file: string, directory = false) {
	// Inspect the OS descriptor without the module autoloader under investigation.
	// PowerShell environment variables use $env:NAME, not properties of $env.
	const script = `$ErrorActionPreference='Stop'; $a=[IO.${directory ? "Directory" : "File"}]::GetAccessControl($env:BRIDGE_ACL_FILE); $rules=@(foreach($r in $a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) { @{sid=$r.IdentityReference.Value; inherited=$r.IsInherited; rights=[int]$r.FileSystemRights; inheritance=[int]$r.InheritanceFlags; propagation=[int]$r.PropagationFlags; allow=($r.AccessControlType -eq 'Allow')} }); Import-Module ([IO.Path]::Combine($PSHOME,'Modules','Microsoft.PowerShell.Utility','Microsoft.PowerShell.Utility.psd1')); @{owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value; current=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; protected=$a.AreAccessRulesProtected; rules=$rules}|ConvertTo-Json -Compress -Depth 4`;
	const result = await run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { env: { ...process.env, BRIDGE_ACL_FILE: file }, windowsHide: true });
	return Acl.parse(JSON.parse(result.stdout));
}

function expectPrivate(actual: z.infer<typeof Acl>, directory = false, inherited = false) {
	// DACL inheritance does not inherit ownership; elevated tokens may default to Administrators.
	if (!inherited) expect(actual.owner).toBe(actual.current);
	expect(actual.protected).toBe(!inherited);
	expect(actual.rules).toEqual([{ sid: actual.current, inherited, rights: 2032127, inheritance: directory ? 3 : 0, propagation: 0, allow: true }]);
}

async function environment(root: string, mode: "polluted" | "missing") {
	const env = { ...process.env };
	// The child process alone gets this environment; never mutate the test runner.
	for (const key of Object.keys(env)) if (key.toLowerCase() === "psmodulepath") delete env[key];
	if (mode === "polluted") {
		const modules = path.join(root, "foreign modules");
		for (const [name, commands] of [
			["Microsoft.PowerShell.Security", ["Set-Acl", "Get-Acl", "Get-FileHash"]],
			["Microsoft.PowerShell.Management", ["Test-Path", "Get-Item", "Join-Path"]],
			["Microsoft.PowerShell.Utility", ["New-Object", "ConvertTo-Json", "Select-Object", "Out-String"]],
		] as const) {
			const directory = path.join(modules, name);
			await mkdir(directory, { recursive: true });
			await writeFile(path.join(directory, `${name}.psd1`), `@{ModuleVersion='1.0.0'; RootModule='foreign.psm1'; FunctionsToExport=@(${commands.map(command => `'${command}'`).join(",")})}`);
			await writeFile(path.join(directory, "foreign.psm1"), "throw 'Foreign PowerShell module must not be loaded'\n");
		}
		env.PSModulePath = modules;
	}
	return env;
}

for (const mode of ["polluted", "missing"] as const) {
	test.skipIf(process.platform !== "win32")(`private JSON keeps real owner-only ACLs with ${mode} PSModulePath and literal Unicode paths`, async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "bridge-config-acl-"));
		try {
			const directory = path.join(root, "目录 空格 ' $([throw]) & ` [x]");
			const file = path.join(directory, "凭据 ' $([throw]) & ` [x].json");
			const value = { unicode: "中文🙂", literal: "' $([throw]) & ` [x]", secret: "synthetic-test-only" };
			const env = { ...await environment(root, mode), BRIDGE_ACL_FILE: file };
			const code = `import {writePrivateJson} from ${JSON.stringify(config)}; await writePrivateJson(process.env.BRIDGE_ACL_FILE, ${JSON.stringify(value)});`;
			await run(process.execPath, ["-e", code], { env, timeout: 30_000, windowsHide: true });
			expect(await readFile(file, "utf8")).toBe(JSON.stringify(value, null, 2) + "\n");
			expectPrivate(await acl(directory, true), true);
			expectPrivate(await acl(file));
			const child = path.join(directory, "inherited.txt");
			await writeFile(child, "inherited private bytes");
			expectPrivate(await acl(child), false, true);
			// Atomic replacement must retain the same private descriptor and exact bytes.
			await run(process.execPath, ["-e", code], { env, timeout: 30_000, windowsHide: true });
			expectPrivate(await acl(file));
			expect((await readdir(directory)).sort()).toEqual([path.basename(file), "inherited.txt"].sort());
		} finally { await rm(root, { recursive: true, force: true }); }
	}, 60_000);

	test.skipIf(process.platform !== "win32")(`Windows bootstrap secures storage before recording a real failure with ${mode} PSModulePath`, async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "bridge-bootstrap-acl-"));
		try {
			const directory = path.join(root, "引导 空格 ' $([throw]) & ` [x]");
			const env = await environment(root, mode);
			env.PATH = [path.dirname(process.execPath), process.env.PATH].join(path.delimiter);
			const result = await run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", bootstrap, "-PluginRoot", path.join(root, "absent package"), "-DataDir", directory, "-HostAlias", "fixture-host"], { env, timeout: 30_000, windowsHide: true }).then(() => ({ code: 0, stderr: "" }), (error: { code: number; stderr: string }) => error);
			expect(result.code).toBe(1);
			expect(result.stderr).toContain("Cannot launch package preparation");
			expectPrivate(await acl(directory, true), true);
			expectPrivate(await acl(path.join(directory, "runtime"), true), true, true);
			const state = path.join(directory, "setup-state.json");
			expect(JSON.parse(await readFile(state, "utf8"))).toMatchObject({ schema: 1, status: "failed", stage: "runtime", message: "Cannot launch package preparation. Reinstall the complete Tern plugin and retry." });
			expectPrivate(await acl(state), false, true);
		} finally { await rm(root, { recursive: true, force: true }); }
	}, 60_000);
}

test.skipIf(process.platform !== "win32")("private ACL errors reject without publishing JSON or modifying an existing blocker", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "bridge-acl-errors-"));
	try {
		const blocker = path.join(root, "not a directory");
		await writeFile(blocker, "existing owner data");
		const env = { ...await environment(root, "polluted"), BRIDGE_ACL_FILE: path.join(root, "absent.json"), BRIDGE_ACL_BLOCKER: blocker };
		const code = `import {protectPrivatePath, writePrivateJson} from ${JSON.stringify(config)}; let rejected=0; try { await protectPrivatePath(process.env.BRIDGE_ACL_FILE); } catch { rejected++; } try { await writePrivateJson(process.env.BRIDGE_ACL_BLOCKER + '/private.json', {secret:'must not publish'}); } catch { rejected++; } console.log(rejected);`;
		const result = await run(process.execPath, ["-e", code], { env, timeout: 30_000, windowsHide: true });
		expect(result.stdout.trim()).toBe("2");
		expect(await readFile(blocker, "utf8")).toBe("existing owner data");
		expect((await readdir(root)).sort()).toEqual(["foreign modules", "not a directory"]);
	} finally { await rm(root, { recursive: true, force: true }); }
}, 60_000);

test.skipIf(process.platform !== "win32")("denied ACL ownership updates fail closed before JSON or bootstrap progress is written", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "bridge-acl-denied-"));
	const directory = path.join(root, "writable 目录 ' $([throw]) & ` [x]");
	await mkdir(directory);
	// Retain WRITE_DAC for cleanup, but remove WRITE_OWNER so setting the required
	// owner fails. Ordinary file writes still work: absence of output is fail-closed,
	// not an incidental inability to write setup-state.json.
	const setRights = async (restore: boolean) => {
		const rights = restore ? "[Security.AccessControl.FileSystemRights]::FullControl" : "([Security.AccessControl.FileSystemRights]::FullControl -band (-bnot [Security.AccessControl.FileSystemRights]::TakeOwnership))";
		const script = `$ErrorActionPreference='Stop'; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $a=[Security.AccessControl.DirectorySecurity]::new(); $a.SetAccessRuleProtection($true,$false); $a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,${rights},'ContainerInherit,ObjectInherit','None','Allow')); [IO.Directory]::SetAccessControl($env:BRIDGE_ACL_FILE,$a)`;
		await run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { env: { ...process.env, BRIDGE_ACL_FILE: directory }, windowsHide: true });
	};
	try {
		await setRights(false);
		const probe = path.join(directory, "writable.txt");
		await writeFile(probe, "write permission remains available");
		expect(await readFile(probe, "utf8")).toBe("write permission remains available");
		await rm(probe);
		const env = { ...process.env, BRIDGE_ACL_FILE: path.join(directory, "secret.json") };
		const code = `import {writePrivateJson} from ${JSON.stringify(config)}; await writePrivateJson(process.env.BRIDGE_ACL_FILE, {secret:'must not publish'});`;
		await expect(run(process.execPath, ["-e", code], { env, timeout: 30_000, windowsHide: true })).rejects.toMatchObject({ code: 1 });
		expect(await readdir(directory)).toEqual([]);
		const result = await run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", bootstrap, "-PluginRoot", path.join(root, "absent package"), "-DataDir", directory, "-HostAlias", "fixture-host"], { env, timeout: 30_000, windowsHide: true }).then(() => ({ code: 0, stderr: "" }), (error: { code: number; stderr: string }) => error);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Cannot prepare private runtime storage");
		expect(await readdir(directory)).toEqual([]);
	} finally { await setRights(true); await rm(root, { recursive: true, force: true }); }
}, 60_000);

test.skipIf(process.platform !== "win32")("bootstrap atomically replaces old state and an existing runtime without losing either file on failure", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "bridge-bootstrap-publish-目录 ' $([throw]) & ` [x]-"));
	try {
		// Load only the production publication function with PowerShell's parser:
		// exercise real filesystem operations without downloading or launching setup.
		const bootstrapFixture = path.join(root, "引导.ps1");
		await copyFile(bootstrap, bootstrapFixture);
		const script = `$ErrorActionPreference='Stop'; $tokens=$null; $errors=$null; $ast=[Management.Automation.Language.Parser]::ParseFile($env:BRIDGE_BOOTSTRAP,[ref]$tokens,[ref]$errors); if($errors.Count){throw $errors[0]}; $definition=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Publish-File'},$false); if(-not $definition){throw 'Missing publication function'}; . ([scriptblock]::Create($definition.Extent.Text)); Publish-File $env:BRIDGE_SOURCE $env:BRIDGE_DESTINATION`;
		for (const name of ["setup-state.json", "bun.exe"]) {
			const destination = path.join(root, name);
			const source = path.join(root, `replacement-${name}`);
			const original = Buffer.from([0, 1, 2, 255]);
			const replacement = Buffer.from([77, 90, 0, 128, 254, 13, 10]);
			await writeFile(destination, original);
			const env = { ...process.env, BRIDGE_BOOTSTRAP: bootstrapFixture, BRIDGE_SOURCE: source, BRIDGE_DESTINATION: destination };
			const publish = () => run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { env, timeout: 30_000, windowsHide: true });
			await expect(publish()).rejects.toMatchObject({ code: 1 });
			expect(await readFile(destination)).toEqual(original);
			await writeFile(source, replacement);
			await publish();
			expect(await readFile(destination)).toEqual(replacement);
			await expect(readFile(source)).rejects.toMatchObject({ code: "ENOENT" });
		}
		expect((await readdir(root)).sort()).toEqual(["bun.exe", "setup-state.json", "引导.ps1"].sort());
	} finally { await rm(root, { recursive: true, force: true }); }
}, 60_000);

test.skipIf(process.platform !== "win32")("native preparer stderr cannot overwrite its outcome or backend progress", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "bridge-bootstrap-outcome-"));
	try {
		const plugin = path.join(root, "package with spaces");
		await mkdir(path.join(plugin, "scripts"), { recursive: true });
		for (const exitCode of [0, 23]) {
			const directory = path.join(root, `data-${exitCode}`);
			const progress = { schema: 1, status: exitCode ? "failed" : "awaiting_session", stage: "connecting-client", updatedAt: 1 };
			await writeFile(path.join(plugin, "scripts", "build.ts"), `import {writeFile} from 'node:fs/promises'; await writeFile(${JSON.stringify(path.join(directory, "setup-state.json"))}, ${JSON.stringify(JSON.stringify(progress))}); console.error('private fixture diagnostics'); process.exit(${exitCode});`);
			const env = { ...process.env, PATH: [path.dirname(process.execPath), process.env.PATH].join(path.delimiter) };
			const result = await run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", bootstrap, "-PluginRoot", plugin, "-DataDir", directory, "-HostAlias", "fixture-host"], { env, timeout: 30_000, windowsHide: true }).then(value => ({ code: 0, stderr: value.stderr }), (error: { code: number; stderr: string }) => error);
			expect(result.code).toBe(exitCode);
			expect(JSON.parse(await readFile(path.join(directory, "setup-state.json"), "utf8"))).toEqual(progress);
			expect(result.stderr).not.toContain("private fixture diagnostics");
		}
	} finally { await rm(root, { recursive: true, force: true }); }
}, 60_000);
