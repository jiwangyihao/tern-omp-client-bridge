// SPDX-License-Identifier: MPL-2.0
import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { isAbsoluteTernPaneSocketPath } from "../../src/tern-routing.ts";

const runFile = promisify(execFile);
const resolver = new URL("../../src/tern-routing.ts", import.meta.url).href;
const roots: string[] = [];

async function fixture(): Promise<string> {
	const root = await mkdtemp(path.join(os.tmpdir(), "tern-routing-"));
	roots.push(root);
	return root;
}

afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function resolveInFixture(root: string, options: { explicit?: string; saved?: unknown; configDirectory?: string; isolated?: boolean } = {}, environment: Record<string, string> = {}): Promise<string | undefined> {
	const script = `import { resolveTernPaneSocket } from ${JSON.stringify(resolver)};
try { console.log(JSON.stringify({ socket: await resolveTernPaneSocket(${JSON.stringify({ configDirectory: path.join(root, "settings"), ...options })}) })); }
catch (error) { console.error(error.message); process.exitCode = 1; }`;
	const { stdout } = await runFile(process.execPath, ["-e", script], {
		cwd: root,
		timeout: 10_000,
		env: {
			...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
			...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
			HOME: root,
			USERPROFILE: root,
			...environment,
		},
	});
	return JSON.parse(stdout).socket;
}

test("explicit literal endpoint wins over saved and ambient routes without requiring a running daemon", async () => {
	const root = await fixture();
	const explicit = path.join(root, "安装 with spaces 'quote';$literal", "daemon.sock");
	expect(await resolveInFixture(root, { explicit, saved: path.join(root, "saved.sock") }, {
		TERN_PANE_SOCKET: path.join(root, "pane.sock"),
		TERN_DAEMON_SOCKET: path.join(root, "daemon.sock"),
	})).toBe(explicit);
});

test("saved endpoint survives daemon downtime and wins over ambient routes", async () => {
	const root = await fixture();
	const saved = path.join(root, "missing 安装", "daemon.sock");
	expect(await resolveInFixture(root, { saved }, {
		TERN_PANE_SOCKET: path.join(root, "pane.sock"),
		TERN_DAEMON_SOCKET: path.join(root, "daemon.sock"),
	})).toBe(saved);
});

test("pane environment wins over daemon environment for the native profile", async () => {
	const root = await fixture();
	const pane = path.join(root, "pane.sock");
	expect(await resolveInFixture(root, {}, {
		TERN_PANE_SOCKET: pane,
		TERN_DAEMON_SOCKET: path.join(root, "daemon.sock"),
	})).toBe(pane);
});

test("daemon environment supplies a route when no pane route is set", async () => {
	const root = await fixture();
	const daemon = path.join(root, "daemon.sock");
	expect(await resolveInFixture(root, {}, { TERN_PANE_SOCKET: "", TERN_DAEMON_SOCKET: daemon })).toBe(daemon);
});

test.each([null, false, 42, {}, "relative/socket", "bad\npath"])("invalid saved route %j falls through to the native environment", async saved => {
	const root = await fixture();
	const pane = path.join(root, "pane.sock");
	expect(await resolveInFixture(root, { saved }, { TERN_PANE_SOCKET: pane })).toBe(pane);
});

test("isolated target captures no ambient socket and invents no settings-directory route", async () => {
	const root = await fixture();
	expect(await resolveInFixture(root, { isolated: true }, {
		TERN_PANE_SOCKET: path.join(root, "unrelated-pane.sock"),
		TERN_DAEMON_SOCKET: path.join(root, "unrelated-daemon.sock"),
		XDG_RUNTIME_DIR: path.join(root, "unrelated-runtime"),
		TERN_CONFIG_DIR: path.join(root, "unrelated-settings"),
	})).toBeUndefined();
});

test("isolated target with an invalid saved route remains unrouted", async () => {
	const root = await fixture();
	expect(await resolveInFixture(root, { isolated: true, saved: "relative.sock" }, { TERN_PANE_SOCKET: path.join(root, "unrelated.sock") })).toBeUndefined();
});

test("isolated target retains its saved route and permits an explicit repair", async () => {
	const root = await fixture();
	const saved = path.join(root, "saved.sock");
	const explicit = path.join(root, "repaired.sock");
	expect(await resolveInFixture(root, { isolated: true, saved }, { TERN_PANE_SOCKET: "relative-invalid" })).toBe(saved);
	expect(await resolveInFixture(root, { isolated: true, explicit, saved })).toBe(explicit);
});

test.each(["", "daemon.sock", "./daemon.sock", "~/daemon.sock", "$(socket)", "bad\npath", "bad\u0000path"])("invalid explicit endpoint %j fails rather than falling back", async explicit => {
	const root = await fixture();
	await expect(resolveInFixture(root, { explicit, saved: path.join(root, "saved.sock") })).rejects.toThrow("--tern-pane-socket");
});

test.each(["TERN_PANE_SOCKET", "TERN_DAEMON_SOCKET"])("invalid authoritative %s fails rather than silently selecting a different daemon", async variable => {
	const root = await fixture();
	await expect(resolveInFixture(root, {}, { [variable]: "relative-daemon.sock" })).rejects.toThrow(variable);
});

test.skipIf(process.platform === "win32")("POSIX fallback uses daemon.sock in the supplied native settings directory", async () => {
	const root = await fixture();
	expect(await resolveInFixture(root)).toBe(path.join(root, "settings", "daemon.sock"));
});

test.skipIf(process.platform === "win32")("a relative settings directory cannot produce a relative persisted route", async () => {
	const root = await fixture();
	await expect(resolveInFixture(root, { configDirectory: "relative-settings" })).rejects.toThrow("--tern-pane-socket");
});

test.skipIf(process.platform !== "linux")("Linux uses XDG_RUNTIME_DIR/tern/daemon.sock before the settings directory", async () => {
	const root = await fixture();
	const runtime = path.join(root, "runtime");
	expect(await resolveInFixture(root, {}, { XDG_RUNTIME_DIR: runtime })).toBe(path.join(runtime, "tern", "daemon.sock"));
});

test.skipIf(process.platform !== "linux")("Linux rejects a relative runtime directory instead of persisting a relative endpoint", async () => {
	const root = await fixture();
	await expect(resolveInFixture(root, {}, { XDG_RUNTIME_DIR: "relative-runtime" })).rejects.toThrow("XDG_RUNTIME_DIR");
});

test.skipIf(process.platform !== "darwin")("macOS uses settings rather than a foreign XDG runtime directory", async () => {
	const root = await fixture();
	const configDirectory = path.join(root, "Library", "Application Support", "Tern");
	expect(await resolveInFixture(root, { configDirectory }, { XDG_RUNTIME_DIR: path.join(root, "runtime") })).toBe(path.join(configDirectory, "daemon.sock"));
});

test.skipIf(process.platform !== "win32")("Windows selects the native per-user pipe independently of filesystem settings", async () => {
	const root = await fixture();
	expect(await resolveInFixture(root, { configDirectory: path.join(root, "Roaming", "Tern") }, {
		USERNAME: "Fixture 安装",
		LOCALAPPDATA: path.join(root, "Local"),
		XDG_RUNTIME_DIR: path.join(root, "runtime"),
	})).toBe("\\\\.\\pipe\\tern-Fixture 安装");
});

test.skipIf(process.platform !== "win32")("Windows requires a known user or an authoritative pipe, never a guessed filesystem socket", async () => {
	const root = await fixture();
	await expect(resolveInFixture(root, {}, { USERNAME: "" })).rejects.toThrow("USERNAME");
	await expect(resolveInFixture(root, {}, { USERNAME: "bad\\name" })).rejects.toThrow("--tern-pane-socket");
	const pipe = "\\\\.\\pipe\\tern-Fixture";
	expect(await resolveInFixture(root, {}, { TERN_PANE_SOCKET: pipe })).toBe(pipe);
	expect(await resolveInFixture(root, { saved: pipe, isolated: true })).toBe(pipe);
	expect(await resolveInFixture(root, { explicit: pipe, saved: "C:\\old.sock" })).toBe(pipe);
});

test("Windows endpoint policy accepts fully qualified drive and UNC paths without an executable suffix", () => {
	for (const value of [
		"C:\\Users\\安装 with spaces\\daemon.sock", "D:/Tern/daemon.sock",
		"\\\\server\\share\\Tern\\daemon.sock", "//server/share/Tern/daemon.sock",
		"\\\\?\\C:\\Tern\\daemon.sock", "\\\\?\\UNC\\server\\share\\daemon.sock",
		"\\\\.\\pipe\\tern-Fixture", "\\\\.\\PIPE\\tern-安装 with spaces",
	]) expect(isAbsoluteTernPaneSocketPath(value, "win32")).toBe(true);
	for (const value of [
		"daemon.sock", "C:daemon.sock", "\\Tern\\daemon.sock", "/Tern/daemon.sock",
		"\\\\server", "\\\\server\\share", "C:\\", "\"C:\\Tern\\daemon.sock\"",
		"C:\\Tern\\bad\npath", "C:\\Tern\\bad\u0000path", "C:\\Tern\\bad\u0085path", null, 42,
		"C:\\Tern\\daemon.sock\\", "C:\\Tern\\daemon:stream", "C:\\Tern\\*.sock",
		"\\\\.\\pipe\\", "\\\\.\\pipe\\nested\\name", "\\\\.\\pipe\\tern*", "\\\\.\\pipe\\tern:stream", "\\\\.\\PhysicalDrive0",
		"//./pipe/tern", "\\\\.\\pipe\\bad\nname",
	]) expect(isAbsoluteTernPaneSocketPath(value, "win32")).toBe(false);
});

test.each(["darwin", "linux"] as const)("%s endpoint policy retains spaces, Unicode and literal shell punctuation", platform => {
	for (const value of ["/tmp/安装 with spaces/daemon.sock", "/tmp/'quote';$literal.sock", "/tmp/no-extension"])
		expect(isAbsoluteTernPaneSocketPath(value, platform)).toBe(true);
	for (const value of ["daemon.sock", "./daemon.sock", "~/daemon.sock", "C:\\Tern\\daemon.sock", "/", "/tmp/socket/", "/tmp/bad\npath", "/tmp/bad\u007fpath", null, {}])
		expect(isAbsoluteTernPaneSocketPath(value, platform)).toBe(false);
});
