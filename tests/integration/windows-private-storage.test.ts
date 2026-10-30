// SPDX-License-Identifier: MPL-2.0
import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { protectPrivatePath } from "../../src/config.ts";
import { HumanTransferSource } from "../../src/transfers/source.ts";
import { UploadStore } from "../../src/uploads.ts";

const run = promisify(execFile);
const Acl = z.object({ owner: z.string(), current: z.string(), protected: z.boolean(), rules: z.array(z.object({ sid: z.string(), inherited: z.boolean(), allow: z.boolean(), rights: z.number() })) });
async function acl(file: string) {
	const script = "$ErrorActionPreference='Stop'; $a=if ([IO.Directory]::Exists($env:BRIDGE_ACL_FILE)) { [IO.Directory]::GetAccessControl($env:BRIDGE_ACL_FILE) } else { [IO.File]::GetAccessControl($env:BRIDGE_ACL_FILE) }; $r=@(foreach($entry in $a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) { @{sid=$entry.IdentityReference.Value; inherited=$entry.IsInherited; allow=($entry.AccessControlType -eq 'Allow'); rights=[int]$entry.FileSystemRights} }); Import-Module ([IO.Path]::Combine($PSHOME,'Modules','Microsoft.PowerShell.Utility','Microsoft.PowerShell.Utility.psd1')); @{owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value; current=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; protected=$a.AreAccessRulesProtected; rules=$r}|ConvertTo-Json -Compress -Depth 4";
	const result = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { env: { ...process.env, BRIDGE_ACL_FILE: file }, windowsHide: true });
	return Acl.parse(JSON.parse(result.stdout));
}

test.skipIf(process.platform !== "win32")("private storage removes explicit broad grants and captures never inherit a public source ACL", async () => {
	const root = await mkdtemp(join(tmpdir(), "bridge-private-acl-"));
	const source = new HumanTransferSource({ stateDir: join(root, "state") });
	try {
		const file = join(root, "public synthetic file.txt");
		await writeFile(file, "synthetic private snapshot");
		await run("icacls", [file, "/grant", "*S-1-1-0:(F)"], { windowsHide: true });
		const captured = await source.capture({ kind: "files", paths: [file] });
		const snapshot = source.files(captured.id)[0]!;
		const snapshotAcl = await acl(snapshot.path);
		expect(snapshotAcl.rules.every(rule => rule.sid === snapshotAcl.current && rule.allow)).toBe(true);
		expect(await readFile(snapshot.path, "utf8")).toBe("synthetic private snapshot");
		expect((await acl(file)).rules.some(rule => rule.sid === "S-1-1-0")).toBe(true);
		await protectPrivatePath(file);
		const protectedAcl = await acl(file);
		expect(protectedAcl.protected).toBe(true);
		expect(protectedAcl.owner).toBe(protectedAcl.current);
		expect(protectedAcl.rules).toEqual([{ sid: protectedAcl.current, inherited: false, allow: true, rights: 2032127 }]);
		const directory = join(root, "private directory"); await mkdir(directory);
		await run("icacls", [directory, "/grant", "*S-1-1-0:(OI)(CI)(F)"], { windowsHide: true });
		await protectPrivatePath(directory, true);
		const child = join(directory, "child.txt"); await writeFile(child, "child");
		const childAcl = await acl(child);
		expect(childAcl.rules.every(rule => rule.sid === childAcl.current && rule.allow)).toBe(true);
	} finally { await source.close(); await rm(root, { recursive: true, force: true }); }
}, 60000);

test.skipIf(process.platform !== "win32")("upload staging and published files retain user-only DACLs under a broadly shared parent", async () => {
	const root = await mkdtemp(join(tmpdir(), "bridge-upload-acl-"));
	const imports = join(root, "imports 目录 ' $([throw]) & ` [x]");
	const store = new UploadStore(imports);
	const expectPrivate = async (file: string, inherited: boolean) => {
		const actual = await acl(file);
		// Only explicitly protected paths set the owner; inherited DACLs still grant this user alone.
		if (!inherited) expect(actual.owner).toBe(actual.current);
		expect(actual.protected).toBe(!inherited);
		expect(actual.rules).toEqual([{ sid: actual.current, inherited, allow: true, rights: 2032127 }]);
	};
	try {
		await mkdir(imports);
		await run("icacls", [imports, "/grant", "*S-1-1-0:(OI)(CI)(F)"], { windowsHide: true });
		expect((await acl(imports)).rules.some(rule => rule.sid === "S-1-1-0" && rule.allow)).toBe(true);
		const bytes = Buffer.from("synthetic private upload 中文");
		const upload = await store.begin("client-a", { viewId: "view", sessionId: "session", draftToken: "draft", files: [{ name: "private.txt", size: bytes.length }] });
		const staging = join(imports, `${upload.id}.partial`);
		await expectPrivate(staging, false);
		await expectPrivate(join(staging, "0-private.txt"), true);
		await store.chunk("client-a", { id: upload.id, index: 0, offset: 0, data: bytes.toString("base64") });
		expect(await readFile(join(staging, "0-private.txt"))).toEqual(bytes);
		const completed = await store.finish("client-a", upload.id, [createHash("sha256").update(bytes).digest("hex")]);
		const published = join(imports, upload.id);
		await expectPrivate(published, false);
		expect(completed.files[0]!.path).toBe(join(published, "0-private.txt"));
		await expectPrivate(completed.files[0]!.path, true);
		await expectPrivate(join(published, "README"), true);
		expect(await readFile(completed.files[0]!.path)).toEqual(bytes);
	} finally { await store.close(); await rm(root, { recursive: true, force: true }); }
}, 60_000);
