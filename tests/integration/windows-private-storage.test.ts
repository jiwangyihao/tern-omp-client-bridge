// SPDX-License-Identifier: MPL-2.0
import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { protectPrivatePath } from "../../src/config.ts";
import { HumanTransferSource } from "../../src/transfers/source.ts";

const run = promisify(execFile);
const Acl = z.object({ owner: z.string(), current: z.string(), protected: z.boolean(), rules: z.array(z.object({ sid: z.string(), inherited: z.boolean(), allow: z.boolean() })) });
async function acl(file: string) {
	const script = "$a=Get-Acl -LiteralPath $env.BRIDGE_ACL_FILE; $r=@($a.Access|ForEach-Object{@{sid=$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value; inherited=$_.IsInherited; allow=($_.AccessControlType -eq 'Allow')}}); @{owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value; current=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; protected=$a.AreAccessRulesProtected; rules=$r}|ConvertTo-Json -Compress -Depth 4";
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
		expect(protectedAcl.rules).toEqual([{ sid: protectedAcl.current, inherited: false, allow: true }]);
		const directory = join(root, "private directory"); await mkdir(directory);
		await run("icacls", [directory, "/grant", "*S-1-1-0:(OI)(CI)(F)"], { windowsHide: true });
		await protectPrivatePath(directory, true);
		const child = join(directory, "child.txt"); await writeFile(child, "child");
		const childAcl = await acl(child);
		expect(childAcl.rules.every(rule => rule.sid === childAcl.current && rule.allow)).toBe(true);
	} finally { await source.close(); await rm(root, { recursive: true, force: true }); }
}, 60000);
