import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { inspectSetupPackage } from "../../src/setup-payload.ts";
import { packageArchive } from "../../src/setup-remote.ts";

const run = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test("source archive preserves its digest without platform metadata files", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "bridge-archive-"));
	roots.push(root);
	const source = path.join(root, "source ü");
	const extracted = path.join(root, "extracted");
	const files = ["plugin.toml", "bun.lock", "src/cli.ts", "scripts/build.ts", "scripts/bootstrap.sh", "scripts/bootstrap.ps1", "docs/usage.md"];
	for (const file of files) {
		await mkdir(path.dirname(path.join(source, file)), { recursive: true });
		await writeFile(path.join(source, file), `archive fixture: ${file}\n`);
	}
	await writeFile(path.join(source, "package.json"), JSON.stringify({ files: ["plugin.toml", "bun.lock", "src", "scripts", "docs"] }));
	if (process.platform === "darwin") await run("xattr", ["-w", "com.apple.ResourceFork", "metadata-is-not-source", path.join(source, "docs/usage.md")]);
	const archive = await packageArchive(source, path.join(root, "data"), path.join(root, "archive.log"));
	// Read regular-member headers directly: macOS tar transparently consumes AppleDouble entries.
	const bytes = Buffer.from(archive.bytes);
	const members: string[] = [];
	for (let offset = 0; offset + 512 <= bytes.length && bytes[offset] !== 0;) {
		const name = bytes.subarray(offset, offset + 100).toString().split("\0")[0]!;
		const size = parseInt(bytes.subarray(offset + 124, offset + 136).toString().replace(/\0/g, "").trim(), 8);
		const type = bytes[offset + 156];
		if (type === 0 || type === 48) members.push(name);
		offset += 512 + Math.ceil(size / 512) * 512;
	}
	expect(members.sort()).toEqual((await inspectSetupPackage(source)).files);
	const tar = path.join(root, "source.tar");
	await writeFile(tar, archive.bytes);
	await mkdir(extracted);
	await run("tar", ["-xf", tar, "-C", extracted]);
	const actual = await inspectSetupPackage(extracted);
	expect(actual.digest).toBe(archive.digest);
	expect(actual.files).toEqual((await inspectSetupPackage(source)).files);
}, 15000);
