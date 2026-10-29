// SPDX-License-Identifier: MPL-2.0
import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { isAbsoluteTernExecutablePath } from "../../src/tern-executable.ts";

const runFile = promisify(execFile);
const resolver = new URL("../../src/tern-executable.ts", import.meta.url).href;
const executableName = process.platform === "win32" ? "tern.exe" : "tern";
const roots: string[] = [];

async function fixture(): Promise<string> {
	const root = await mkdtemp(path.join(os.tmpdir(), "tern-executable-"));
	roots.push(root);
	await mkdir(path.join(root, "home"));
	await mkdir(path.join(root, "path"));
	return root;
}

afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function executable(file: string): Promise<string> {
	await mkdir(path.dirname(file), { recursive: true });
	// Discovery must only inspect metadata, never execute or probe these fixtures.
	await writeFile(file, "not a Tern executable; do not execute\n", { mode: 0o755 });
	return file;
}

async function resolveInFixture(root: string, options: { explicit?: string; saved?: unknown } = {}, environment: Record<string, string> = {}): Promise<string> {
	const script = `import { resolveTernExecutable } from ${JSON.stringify(resolver)};
try { console.log(JSON.stringify(await resolveTernExecutable(${JSON.stringify(options)}))); }
catch (error) { console.error(error.message); process.exitCode = 1; }`;
	const { stdout } = await runFile(process.execPath, ["-e", script], {
		cwd: root,
		timeout: 10_000,
		env: {
			// Do not inherit shell PATH, user directories, or APPIMAGE from the runner.
			...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
			...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
			PATH: path.join(root, "path"),
			PATHEXT: ".COM;.EXE;.BAT;.CMD",
			HOME: path.join(root, "home"),
			USERPROFILE: path.join(root, "home"),
			LOCALAPPDATA: path.join(root, "local app data"),
			ProgramFiles: path.join(root, "program files"),
			APPIMAGE: "",
			...environment,
		},
	});
	return JSON.parse(stdout);
}

test("explicit executable takes precedence over saved, PATH, and conventional entries", async () => {
	const root = await fixture();
	const explicit = await executable(path.join(root, "custom 安装 with spaces 'quote';$literal", executableName));
	const saved = await executable(path.join(root, "saved", executableName));
	await executable(path.join(root, "path", executableName));
	await executable(path.join(root, "home", ".local", "bin", executableName));
	expect(await resolveInFixture(root, { explicit, saved })).toBe(explicit);
});

test("usable saved executable takes precedence over PATH discovery", async () => {
	const root = await fixture();
	const saved = await executable(path.join(root, "saved 安装 with spaces", executableName));
	await executable(path.join(root, "path", executableName));
	expect(await resolveInFixture(root, { saved })).toBe(saved);
});

test("PATH discovery precedes conventional locations", async () => {
	const root = await fixture();
	const found = await executable(path.join(root, "path", executableName));
	await executable(path.join(root, "home", ".local", "bin", executableName));
	expect(await resolveInFixture(root)).toBe(found);
});

test.each([null, false, 42, {}, "relative/tern", "bad\npath"])("malformed saved value %j falls through to isolated PATH discovery", async saved => {
	const root = await fixture();
	const found = await executable(path.join(root, "path", executableName));
	expect(await resolveInFixture(root, { saved })).toBe(found);
});

test("stale saved executable falls through to PATH discovery", async () => {
	const root = await fixture();
	const found = await executable(path.join(root, "path", executableName));
	expect(await resolveInFixture(root, { saved: path.join(root, "missing", executableName) })).toBe(found);
});

test("GUI environment without a Tern PATH entry discovers the user-local executable", async () => {
	const root = await fixture();
	const found = await executable(path.join(root, "home", ".local", "bin", executableName));
	expect(await resolveInFixture(root, { saved: path.join(root, "stale", executableName) })).toBe(found);
});

test.each(["", "tern", "relative/tern", "~/bin/tern", "bad\npath", "bad\u0000path"])("invalid explicit path %j fails instead of falling back", async explicit => {
	const root = await fixture();
	const saved = await executable(path.join(root, "saved", executableName));
	await executable(path.join(root, "path", executableName));
	await expect(resolveInFixture(root, { explicit, saved })).rejects.toThrow("--tern-executable");
});

test("missing explicit executable fails even when saved and PATH entries are usable", async () => {
	const root = await fixture();
	const saved = await executable(path.join(root, "saved", executableName));
	await executable(path.join(root, "path", executableName));
	await expect(resolveInFixture(root, { explicit: path.join(root, "missing", executableName), saved })).rejects.toThrow("--tern-executable");
});

test("a directory is rejected explicitly and ignored as a saved executable", async () => {
	const root = await fixture();
	const directory = path.join(root, "directory", executableName);
	await mkdir(directory, { recursive: true });
	const found = await executable(path.join(root, "path", executableName));
	await expect(resolveInFixture(root, { explicit: directory })).rejects.toThrow("--tern-executable");
	expect(await resolveInFixture(root, { saved: directory })).toBe(found);
});

test.skipIf(process.platform === "win32")("POSIX non-executable files are rejected explicitly and ignored when saved", async () => {
	const root = await fixture();
	const blocked = await executable(path.join(root, "blocked", "tern"));
	await chmod(blocked, 0o600);
	const found = await executable(path.join(root, "path", "tern"));
	await expect(resolveInFixture(root, { explicit: blocked })).rejects.toThrow("--tern-executable");
	expect(await resolveInFixture(root, { saved: blocked })).toBe(found);
});

test.skipIf(process.platform === "win32")("stable symlink entrypoints are retained rather than resolved to versioned targets", async () => {
	const root = await fixture();
	const target = await executable(path.join(root, "versions", "1.2.3", "tern"));
	const entry = path.join(root, "home", ".local", "bin", "tern");
	await mkdir(path.dirname(entry), { recursive: true });
	await symlink(target, entry);
	expect(await resolveInFixture(root, { explicit: entry })).toBe(entry);
	expect(await resolveInFixture(root, { saved: entry })).toBe(entry);
	expect(await resolveInFixture(root)).toBe(entry);
});

test.skipIf(process.platform === "win32")("dangling saved symlinks are ignored", async () => {
	const root = await fixture();
	const entry = path.join(root, "stale-tern");
	await symlink(path.join(root, "missing", "tern"), entry);
	const found = await executable(path.join(root, "path", "tern"));
	expect(await resolveInFixture(root, { saved: entry })).toBe(found);
});

test.skipIf(process.platform !== "darwin")("macOS discovers a user Applications Tern bundle without shell PATH", async () => {
	const root = await fixture();
	const found = await executable(path.join(root, "home", "Applications", "Tern.app", "Contents", "MacOS", "tern"));
	expect(await resolveInFixture(root)).toBe(found);
});

test.skipIf(process.platform !== "linux")("Linux discovers an executable APPIMAGE entrypoint without shell PATH", async () => {
	const root = await fixture();
	const found = await executable(path.join(root, "Tern 安装 with spaces.AppImage"));
	expect(await resolveInFixture(root, {}, { APPIMAGE: found })).toBe(found);
});

test.skipIf(process.platform !== "linux")("Linux does not adopt a parent editor's APPIMAGE as Tern", async () => {
	const root = await fixture();
	const unrelated = await executable(path.join(root, "Unrelated Editor.AppImage"));
	let selected: string;
	try { selected = await resolveInFixture(root, {}, { APPIMAGE: unrelated }); }
	catch (error) {
		expect(String(error)).toContain("Tern executable not found");
		return;
	}
	expect(selected).not.toBe(unrelated);
});

test.skipIf(process.platform !== "win32").each([
	{ segments: ["local app data", "Tern", "tern.exe"] },
	{ segments: ["local app data", "Programs", "Tern", "tern.exe"] },
	{ segments: ["program files", "Tern", "tern.exe"] },
])("Windows discovers native executable in %j", async ({ segments }) => {
	const root = await fixture();
	const found = await executable(path.join(root, ...segments));
	expect(await resolveInFixture(root)).toBe(found);
});

test.skipIf(process.platform !== "win32")("Windows rejects batch wrappers and discovers a native executable instead", async () => {
	const root = await fixture();
	const wrapper = await executable(path.join(root, "path", "tern.cmd"));
	await executable(path.join(root, "path", "tern.bat"));
	const found = await executable(path.join(root, "home", ".local", "bin", "tern.exe"));
	await expect(resolveInFixture(root, { explicit: wrapper })).rejects.toThrow("--tern-executable");
	expect(await resolveInFixture(root, { saved: wrapper })).toBe(found);
});

test("Windows lexical policy requires a fully qualified native executable path", () => {
	for (const value of [
		"C:\\Program Files\\Tern 安装\\tern.exe",
		"D:/Tern with spaces/TERN.EXE",
		"\\\\server\\share\\Tern\\tern.exe",
		"//server/share/Tern/tern.exe",
		"\\\\?\\C:\\Tern\\tern.exe",
		"\\\\?\\UNC\\server\\share\\tern.exe",
	]) expect(isAbsoluteTernExecutablePath(value, "win32")).toBe(true);
	for (const value of [
		"tern.exe", "C:tern.exe", "C:folder\\tern.exe", "\\Tern\\tern.exe", "/Tern/tern.exe",
		"\\\\server", "\\\\server\\tern.exe", "//server/tern.exe",
		"C:\\Tern\\tern.cmd", "C:\\Tern\\tern.bat", "C:\\Tern\\tern", "C:\\Tern\\tern.exe --version",
		"\"C:\\Tern\\tern.exe\"", "C:\\Tern\\bad\ntern.exe", "C:\\Tern\\bad\u0000tern.exe",
		"C:\\Tern\\bad\u007ftern.exe", "C:\\Tern\\bad\u0085tern.exe", null, 42,
	]) expect(isAbsoluteTernExecutablePath(value, "win32")).toBe(false);
});

test.each(["darwin", "linux"] as const)("%s lexical policy preserves absolute paths with spaces and Unicode", platform => {
	for (const value of ["/Applications/Tern.app/Contents/MacOS/tern", "/home/用户/Tern with spaces/tern", "/opt/Tern.AppImage", "/tmp/a 'quote';$literal/tern", "//opt/tern", "/tmp/back\\slash/tern"])
		expect(isAbsoluteTernExecutablePath(value, platform)).toBe(true);
	for (const value of ["tern", "./tern", "~/bin/tern", "C:\\Tern\\tern.exe", "/tmp/bad\ntern", "/tmp/bad\u0000tern", null, {}])
		expect(isAbsoluteTernExecutablePath(value, platform)).toBe(false);
});
