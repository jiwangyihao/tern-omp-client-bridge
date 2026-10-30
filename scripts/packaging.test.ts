// SPDX-License-Identifier: MPL-2.0
import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, cp, link, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { startBroker } from "../src/broker.ts";
import { BrokerClient } from "../src/broker-client.ts";
import type { DraftDestination, UiClaim } from "../src/api.ts";
import { loadClientIdentity, signIdentity } from "../src/config.ts";
import { JsonLineDecoder, RpcPeer, WireFrameSchema } from "../src/wire.ts";
import { runRelay } from "../src/relay.ts";
import { acquireBootstrapLock, packageFiles } from "./build.ts";
import { installOmp } from "./install.ts";
import { verifyOmpLoader } from "./verify-omp.ts";

const runFile = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const cli = path.join(root, "src", "cli.ts");
const hostCommand = process.env.BRIDGE_TEST_OMP ? [process.env.BRIDGE_TEST_OMP] : [process.execPath, path.join(root, "node_modules", "@oh-my-pi", "pi-coding-agent", "dist", "cli.js")];
const roots: string[] = [];
const ChallengeSchema = z.object({ nonce: z.string() });
const ReceiptSchema = z.object({ id: z.string(), expiresAt: z.number() });
const ConfigSchema = z.object({ controlFile: z.string(), serverControlFile: z.string(), ternExecutable: z.string(), preserved: z.string() });
const InstallSchema = z.object({ kind: z.string(), loader: z.string().optional(), plugin: z.string().optional(), config: z.string().optional(), controlFile: z.string().optional() });

async function fixture(): Promise<string> {
	const directory = await mkdtemp(path.join(os.tmpdir(), "tern-bridge-packaging-"));
	roots.push(directory);
	return directory;
}

async function command(args: string[], directory: string) {
	const invocation = args[0] === "install-tern" && !args.includes("--tern-executable")
		? [...args, "--tern-executable", process.execPath] : args;
	return runFile(process.execPath, [cli, ...invocation], {
		cwd: directory, timeout: 30_000, maxBuffer: 1024 * 1024,
		env: { ...process.env, PI_CODING_AGENT_DIR: path.join(directory, "native-agent"), TERN_OMP_BRIDGE_HOME: path.join(directory, "bridge-state") },
	});
}

afterEach(async () => { for (const directory of roots.splice(0)) await rm(directory, { recursive: true, force: true }); });

test("help and strict argument errors are finite and do not create bridge identity", async () => {
	const directory = await fixture();
	for (const args of [["unknown"], ["server", "--port", "0"], ["server", "--port", "65536"], ["client"], ["install-tern", "--unknown", "x"]]) {
		await expect(command(args, directory)).rejects.toThrow();
	}
	expect(await readdir(directory)).not.toContain("bridge-state");
}, 120_000);

test("finite installers preserve unrelated settings and write real native plugin entrypoints", async () => {
	const directory = await fixture();
	const tern = path.join(directory, "Tern config ü");
	const omp = path.join(directory, "OMP agent ü");
	const data = path.join(tern, "plugin-data", "omp-client-bridge");
	await mkdir(data, { recursive: true });
	await mkdir(path.join(omp, "extensions"), { recursive: true });
	const settings = "{\"plugins\":true,\"plugins_disabled\":[\"other\"],\"theme\":\"unchanged\"}\n";
	await writeFile(path.join(tern, "settings.json"), settings);
	await writeFile(path.join(data, "config.json"), JSON.stringify({ preserved: "unchanged", controlFile: "old" }));
	await writeFile(path.join(omp, "settings.json"), "{\"unrelated\":true}\n");
	await writeFile(path.join(omp, "extensions", "unrelated.ts"), "export default () => {};\n");
	const control = path.join(directory, "bridge-state", "client.json");
	for (let attempt = 0; attempt < 2; attempt++) {
		const result = InstallSchema.parse(JSON.parse((await command(["install-tern", "--target", tern, "--control-file", control], directory)).stdout));
		expect(result.controlFile).toBe(control);
		const plugin = result.plugin!;
		for (const file of await packageFiles(root)) expect(await readFile(path.join(plugin, file))).toEqual(await readFile(path.join(root, file)));
		expect(await readdir(plugin)).not.toContain("node_modules");
		expect(await readdir(path.join(plugin, "tern"))).not.toContain("plugin.toml");
		const config = ConfigSchema.parse(JSON.parse(await readFile(path.join(data, "config.json"), "utf8")));
		expect(config).toEqual({ preserved: "unchanged", controlFile: control, serverControlFile: path.join(path.dirname(control), "server.json"), ternExecutable: process.execPath });
		expect(await readFile(path.join(tern, "settings.json"), "utf8")).toBe(settings);
		const native = await installOmp(omp, { hostCommand });
		expect(native.loader).toBe(path.join(omp, "extensions", "tern-omp-client-bridge", "index.ts"));
		// Verify the published entry through the host graph, including cross-volume loaders.
		await verifyOmpLoader(native.loader, hostCommand);
	}
	expect(await readFile(path.join(omp, "settings.json"), "utf8")).toBe("{\"unrelated\":true}\n");
	expect(await readFile(path.join(omp, "extensions", "unrelated.ts"), "utf8")).toBe("export default () => {};\n");
	expect(await readdir(directory)).not.toContain("bridge-state");
}, 120_000);

test("absolute native CLI paths survive GUI PATH and invalid overrides preserve installed config", async () => {
	const directory = await fixture();
	const executableDirectory = path.join(directory, "CLI 'literal' ü");
	await mkdir(executableDirectory);
	const executable = path.join(executableDirectory, process.platform === "win32" ? "tern.exe" : "tern");
	try { await link(process.execPath, executable); }
	catch (error) {
		if (!(error instanceof Error && "code" in error && ["EXDEV", "EPERM", "EACCES", "ENOTSUP"].includes(String(error.code)))) throw error;
		await cp(process.execPath, executable, { mode: constants.COPYFILE_FICLONE, errorOnExist: true, force: false });
	}
	const target = path.join(directory, "GUI config");
	const installed = InstallSchema.parse(JSON.parse((await command(["install-tern", "--target", target, "--tern-executable", executable], directory)).stdout));
	const configBefore = await readFile(installed.config!, "utf8");
	const config = z.object({ ternExecutable: z.string() }).parse(JSON.parse(configBefore));
	expect(config.ternExecutable).toBe(executable);
	const emptyPath = path.join(directory, "empty-path");
	await mkdir(emptyPath);
	const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path")), PATH: emptyPath };
	const launched = await runFile(config.ternExecutable, ["--version"], { env, timeout: 10000, windowsHide: true });
	expect(launched.stdout.trim()).toBe(Bun.version);
	await expect(command(["install-tern", "--target", target, "--tern-executable", executable + " --not-an-argument"], directory)).rejects.toThrow();
	expect(await readFile(installed.config!, "utf8")).toBe(configBefore);
	await expect(command(["install-tern", "--target", target, "--tern-pane-socket", "relative/daemon.sock"], directory)).rejects.toThrow();
	expect(await readFile(installed.config!, "utf8")).toBe(configBefore);
}, 60000);

test("installers refuse unrelated loader collisions without changing their contents", async () => {
	const directory = await fixture();
	const target = path.join(directory, "agent");
	const extension = path.join(target, "extensions", "tern-omp-client-bridge");
	await mkdir(extension, { recursive: true });
	const file = path.join(extension, "index.ts");
	const contents = "export default function unrelated() {}\n";
	await writeFile(file, contents);
	await expect(command(["install-omp", "--target", target], directory)).rejects.toThrow();
	expect(await readFile(file, "utf8")).toBe(contents);
}, 60_000);

test("real identity storage has native private permissions and retains its key", async () => {
	const directory = await fixture();
	const state = path.join(directory, "private state ü");
	const first = await loadClientIdentity(state, { name: "Synthetic fixture" });
	const second = await loadClientIdentity(state);
	expect(second.device.id).toBe(first.device.id);
	const file = path.join(state, "identity.json");
	if (process.platform === "win32") {
		const acl = await runFile("icacls", [file], { windowsHide: true });
		expect(acl.stdout).not.toContain("(I)");
		// Verify numeric broad-group SIDs too, independent of the runner's UI language.
		const rules = await runFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; $a=[IO.File]::GetAccessControl($env:BRIDGE_ACL_TEST_FILE); foreach($rule in $a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) { [Console]::WriteLine($rule.IdentityReference.Value) }"], { env: { ...process.env, BRIDGE_ACL_TEST_FILE: file }, windowsHide: true });
		for (const broad of ["S-1-1-0", "S-1-5-11", "S-1-5-32-545"]) expect(rules.stdout.split(/\r?\n/)).not.toContain(broad);
	} else {
		expect((await stat(file)).mode & 0o777).toBe(0o600);
		expect((await stat(state)).mode & 0o777).toBe(0o700);
	}
}, 60_000);

test("relay transports real authenticated registration and draft resolution, then closes on EOF", async () => {
	const directory = await fixture();
	const stateDir = path.join(directory, "server");
	const server = await startBroker({ stateDir });
	const broker = new BrokerClient({ endpoint: server.endpoint });
	const identity = await loadClientIdentity(path.join(directory, "client"), { name: "Relay fixture" });
	const relay = Bun.spawn([process.execPath, cli, "relay", "--state-dir", stateDir], {
		cwd: directory, stdin: "pipe", stdout: "pipe", stderr: "pipe",
		env: { ...process.env, PI_CODING_AGENT_DIR: path.join(directory, "native-agent") },
	});
	const stderr = new Response(relay.stderr).text();
	const challenge = Promise.withResolvers<string>();
	const resolved = Promise.withResolvers<unknown>();
	const peer = new RpcPeer(frame => { relay.stdin.write(JSON.stringify(frame) + "\n"); }, undefined, (name, body) => {
		if (name === "challenge") challenge.resolve(ChallengeSchema.parse(body).nonce);
		if (name === "view.resolved") resolved.resolve(body);
	});
	const decode = new JsonLineDecoder(value => peer.receive(value));
	const reader = (async () => { for await (const chunk of relay.stdout) decode.push(chunk); decode.end(); })();
	try {
		const nonce = await challenge.promise;
		await peer.request("register", { device: identity.device, publicKey: identity.publicKey, signature: signIdentity(nonce, identity) });
		const destinationReady = Promise.withResolvers<DraftDestination>();
		const claimReady = Promise.withResolvers<UiClaim>();
		broker.openDraft("fixture-session", "fixture-draft", {
			onDestination: value => { if (value) destinationReady.resolve(value); },
			onIntent: intent => { void broker.claimIntent(intent.id, intent.sessionId, intent.draftToken, intent.destinationId).then(claimReady.resolve, claimReady.reject); },
			onError: error => { destinationReady.reject(error); claimReady.reject(error); },
		});
		const destination = await destinationReady.promise;
		const receipt = ReceiptSchema.parse(await peer.request("ui.intent", { kind: "resolve", viewId: "fixture-window:pane", destinationId: destination.id }));
		const claimed = await claimReady.promise;
		expect(claimed.id).toBe(receipt.id);
		await broker.finishIntent(claimed.id);
		expect(claimed.state.binding.clientId).toBeNull();
		expect(await resolved.promise).toMatchObject({ viewId: "fixture-window:pane", sessionId: "fixture-session", draftToken: "fixture-draft" });
		relay.stdin.end();
		expect(await relay.exited).toBe(0);
		await reader;
		expect(await stderr).toBe("");
	} finally {
		peer.close();
		broker.close();
		relay.kill();
		await relay.exited;
		await reader.catch(() => undefined);
		await stderr;
		await server.close();
	}
}, 60_000);

test("relay abort and truncated stdin close actual authenticated sockets without retries", async () => {
	const directory = await fixture();
	const stateDir = path.join(directory, "server");
	const server = await startBroker({ stateDir });
	try {
		for (const ending of ["abort", "truncated"] as const) {
			const input = new PassThrough();
			const output = new PassThrough();
			const controller = new AbortController();
			const challenge = Promise.withResolvers<void>();
			const decoder = new JsonLineDecoder(value => {
				const frame = WireFrameSchema.parse(value);
				if (frame.kind === "event" && frame.name === "challenge") { ChallengeSchema.parse(frame.body); challenge.resolve(); }
			});
			output.on("data", (chunk: Buffer) => decoder.push(chunk));
			const running = runRelay({ stateDir, input, output, signal: controller.signal });
			const result = running.then(() => undefined, (error: unknown) => error);
			try {
				const connected = await Promise.race([challenge.promise.then(() => true), running.then(() => false)]);
				expect(connected).toBe(true);
				if (ending === "abort") controller.abort(new Error("fixture cancellation"));
				else input.end("{\"v\":1");
				const error = await result;
				expect(error).toBeInstanceOf(Error);
				expect(error instanceof Error ? error.message : "").toContain(ending === "abort" ? "fixture cancellation" : "during a frame");
				// Completion must remove transport-owned listeners before callers release
				// the stream fixtures or shut down the in-process broker.
				expect(input.listenerCount("data")).toBe(0);
				expect(input.listenerCount("end")).toBe(0);
				expect(input.listenerCount("error")).toBe(0);
			} finally {
				controller.abort();
				await result;
				input.destroy();
				output.destroy();
			}
		}
	} finally { await server.close(); }
}, 30_000);


const ReadySchema = z.object({ kind: z.literal("broker-ready"), url: z.string().url() });

test.skipIf(process.platform === "win32")("server SIGTERM closes its owned listener and preserves the signal exit status", async () => {
	const directory = await fixture();
	const child = Bun.spawn([process.execPath, cli, "server", "--state-dir", path.join(directory, "server")], {
		cwd: directory, stdin: "pipe", stdout: "pipe", stderr: "pipe",
		env: { ...process.env, PI_CODING_AGENT_DIR: path.join(directory, "native-agent") },
	});
	const ready = Promise.withResolvers<string>();
	const decoder = new JsonLineDecoder(value => ready.resolve(ReadySchema.parse(value).url));
	const stderr = new Response(child.stderr).text();
	const reader = (async () => { for await (const chunk of child.stdout) decoder.push(chunk); decoder.end(); })();
	try {
		const endpoint = await Promise.race([ready.promise, child.exited.then(code => { throw new Error(`Server exited before ready (${code})`); })]);
		child.kill("SIGTERM");
		expect(await child.exited).toBe(143);
		await reader;
		expect(await stderr).toBe("");
		await expect(fetch(endpoint, { signal: AbortSignal.timeout(2000) })).rejects.toThrow();
	} finally {
		child.kill();
		await child.exited;
		await reader.catch(() => undefined);
		await stderr;
	}
}, 60_000);

test("finite Tern upgrade retires old manifest entrypoints but preserves neighbors", async () => {
	const directory = await fixture();
	const plugin = path.join(directory, "plugins", "omp-client-bridge");
	await mkdir(plugin, { recursive: true });
	const manifest = (await readFile(path.join(root, "plugin.toml"), "utf8")).replaceAll('"tern/', '"');
	await writeFile(path.join(plugin, "plugin.toml"), manifest);
	for (const file of ["host.luau", "window.luau", "panel.css", "unrelated.txt"]) await writeFile(path.join(plugin, file), "preserve only unrelated");
	await command(["install-tern", "--target", directory], directory);
	const files = await readdir(plugin);
	for (const file of ["host.luau", "window.luau", "panel.css"]) expect(files).not.toContain(file);
	expect(await readFile(path.join(plugin, "unrelated.txt"), "utf8")).toBe("preserve only unrelated");
}, 60_000);

test("legacy upgrades refuse new payload collisions before replacing owned entries", async () => {
	for (const collision of ["src/cli.ts", "scripts/build.ts", "package.json", "docs/usage.md"]) {
		const directory = await fixture();
		const plugin = path.join(directory, "plugins", "omp-client-bridge");
		await mkdir(path.dirname(path.join(plugin, collision)), { recursive: true });
		const manifest = (await readFile(path.join(root, "plugin.toml"), "utf8")).replaceAll('"tern/', '"');
		await writeFile(path.join(plugin, "plugin.toml"), manifest);
		await writeFile(path.join(plugin, "window.luau"), "original owned entry");
		await writeFile(path.join(plugin, collision), "unrelated user content");
		await expect(command(["install-tern", "--target", directory], directory)).rejects.toThrow();
		expect(await readFile(path.join(plugin, collision), "utf8")).toBe("unrelated user content");
		expect(await readFile(path.join(plugin, "plugin.toml"), "utf8")).toBe(manifest);
		expect(await readFile(path.join(plugin, "window.luau"), "utf8")).toBe("original owned entry");
		expect(await readdir(plugin)).not.toContain(".bridge-installed-files.json");
	}
}, 120_000);

test("interrupted payload writes resume before and after manifest replacement", async () => {
	for (const manifestWritten of [false, true]) {
		const directory = await fixture();
		const plugin = path.join(directory, "plugins", "omp-client-bridge");
		await mkdir(path.join(plugin, "scripts"), { recursive: true });
		const copied = await readFile(path.join(root, "scripts/build.ts"));
		await writeFile(path.join(plugin, "scripts/build.ts"), copied);
		const oldWindow = "retired owned entry";
		await writeFile(path.join(plugin, "window.luau"), oldWindow);
		await writeFile(path.join(plugin, "unrelated.txt"), "keep");
		const manifest = await readFile(path.join(root, "plugin.toml"));
		if (manifestWritten) await writeFile(path.join(plugin, "plugin.toml"), manifest);
		const journal = { schema: 1, id: "omp-client-bridge", files: { "scripts/build.ts": createHash("sha256").update(copied).digest("hex"), "plugin.toml": createHash("sha256").update(manifest).digest("hex") }, retired: { "window.luau": createHash("sha256").update(oldWindow).digest("hex") } };
		await writeFile(path.join(plugin, ".bridge-install-journal.json"), JSON.stringify(journal));
		await command(["install-tern", "--target", directory], directory);
		expect(await readFile(path.join(plugin, "scripts/build.ts"))).toEqual(copied);
		expect(await readFile(path.join(plugin, "unrelated.txt"), "utf8")).toBe("keep");
		expect(await readdir(plugin)).not.toContain("window.luau");
		expect(await readdir(plugin)).not.toContain(".bridge-install-journal.json");
		expect(await readdir(plugin)).toContain(".bridge-installed-files.json");
	}
}, 120_000);

test("resumable ownership never adopts a changed uncommitted payload", async () => {
	const directory = await fixture();
	const plugin = path.join(directory, "plugins", "omp-client-bridge");
	await mkdir(path.join(plugin, "scripts"), { recursive: true });
	await writeFile(path.join(plugin, "scripts/build.ts"), "unrelated replacement");
	const intended = await readFile(path.join(root, "scripts/build.ts"));
	const journal = { schema: 1, id: "omp-client-bridge", files: { "scripts/build.ts": createHash("sha256").update(intended).digest("hex") }, retired: {} };
	await writeFile(path.join(plugin, ".bridge-install-journal.json"), JSON.stringify(journal));
	await expect(command(["install-tern", "--target", directory], directory)).rejects.toThrow();
	expect(await readFile(path.join(plugin, "scripts/build.ts"), "utf8")).toBe("unrelated replacement");
	expect(JSON.parse(await readFile(path.join(plugin, ".bridge-install-journal.json"), "utf8"))).toEqual(journal);
}, 60_000);


test.skipIf(process.platform === "win32")("nested plugin symlinks are rejected without modifying their target", async () => {
	const directory = await fixture();
	const plugin = path.join(directory, "plugins", "omp-client-bridge");
	const outside = path.join(directory, "outside");
	await mkdir(plugin, { recursive: true });
	await mkdir(outside);
	await cp(path.join(root, "plugin.toml"), path.join(plugin, "plugin.toml"));
	await symlink(outside, path.join(plugin, "scripts"));
	await expect(command(["install-tern", "--target", directory], directory)).rejects.toThrow();
	expect(await readdir(outside)).toEqual([]);
}, 60_000);

test("dependency-free preparer stages once, preserves argv, and reuses dependencies on source updates", async () => {
	const directory = await fixture();
	const source = path.join(directory, "plugin ü");
	const data = path.join(directory, "data ü");
	await mkdir(path.join(source, "scripts"), { recursive: true });
	await mkdir(path.join(source, "src"));
	const files = ["plugin.toml", "bun.lock", "src", "scripts"];
	const dependency = path.join(directory, "fixture-dependency");
	await mkdir(dependency);
	await writeFile(path.join(dependency, "package.json"), JSON.stringify({ name: "bootstrap-fixture-dependency", version: "1.0.0" }));
	await writeFile(path.join(source, "package.json"), JSON.stringify({ name: "bootstrap-fixture", version: "1.0.0", files, dependencies: { "bootstrap-fixture-dependency": "1.0.0" }, overrides: { "bootstrap-fixture-dependency": `file:${dependency}` } }));
	// Bun deletes empty lockfiles; generate a canonical pinned local dependency lock without registry access.
	await runFile(process.execPath, ["install", "--lockfile-only", "--ignore-scripts"], { cwd: source, timeout: 30_000 });
	// Bun serializes local resolutions relative to the generating directory; this fixture
	// intentionally relocates the package, so anchor its synthetic override absolutely.
	const generatedLock = await readFile(path.join(source, "bun.lock"), "utf8");
	const absoluteResolution = JSON.stringify(`bootstrap-fixture-dependency@file:${dependency}`).slice(1, -1);
	await writeFile(path.join(source, "bun.lock"), generatedLock.replace(/bootstrap-fixture-dependency@file:[^"]+/g, () => absoluteResolution));
	await writeFile(path.join(source, "plugin.toml"), 'schema = 1\n');
	for (const file of ["build.ts", "bootstrap.sh", "bootstrap.ps1"]) await cp(path.join(root, "scripts", file), path.join(source, "scripts", file));
	// Fixture backend proves the real preparer's subprocess boundary without SSH/network mutation.
	await writeFile(path.join(source, "src/cli.ts"), 'console.log(JSON.stringify({argv:process.argv.slice(2)}));\n');
	const host = "fixture-host";
	const args = [path.join(source, "scripts/build.ts"), "bootstrap", source, data, host];
	const expected = ["setup", "--host", host, "--plugin-data", data, "--package-root"];
	const first = await runFile(process.execPath, args, { cwd: directory, timeout: 30_000 });
	const firstArgs = z.object({ argv: z.array(z.string()) }).parse(JSON.parse(first.stdout)).argv;
	expect(firstArgs.slice(0, -1)).toEqual(expected);
	const firstRoot = firstArgs.at(-1)!;
	expect(path.dirname(firstRoot)).toBe(path.join(data, "installation", "packages"));
	const log = path.join(data, "bootstrap.log");
	await writeFile(log, "unchanged dependency log");
	for (const changeSource of [false, true]) {
		if (changeSource) await writeFile(path.join(source, "plugin.toml"), 'schema = 1\n# changed\n');
		const again = await runFile(process.execPath, args, { cwd: directory, timeout: 30_000 });
		const actual = z.object({ argv: z.array(z.string()) }).parse(JSON.parse(again.stdout)).argv;
		expect(actual.slice(0, -1)).toEqual(expected);
		if (changeSource) expect(actual.at(-1)).not.toBe(firstRoot);
		else expect(actual.at(-1)).toBe(firstRoot);
		expect(await readFile(log, "utf8")).toBe("unchanged dependency log");
	}
	expect(await readFile(path.join(firstRoot, "plugin.toml"), "utf8")).toBe("schema = 1\n");
	expect(await readdir(path.join(data, "installation", "packages"))).toHaveLength(2);
	expect(await readdir(path.join(data, "installation", "dependencies"))).toHaveLength(1);
	expect(await readdir(source)).not.toContain("node_modules");
}, 120_000);

test.skipIf(process.platform === "win32")("fresh launcher download and checksum failures stay public, bounded and not ready", async () => {
	for (const failure of ["download", "checksum"]) {
		const directory = await fixture();
		const bin = path.join(directory, "bin");
		const data = path.join(directory, "data");
		await mkdir(bin);
		for (const name of ["mkdir", "chmod", "date", "mv", "rm", "uname", "mktemp", "unzip", "shasum"]) {
			const resolved = (await runFile("which", [name])).stdout.trim();
			await symlink(resolved, path.join(bin, name));
		}
		const curl = path.join(bin, "curl");
		await writeFile(curl, failure === "download" ? '#!/bin/sh\nprintf "secret-download-token" >&2\nexit 22\n' : '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then shift; printf invalid > "$1"; exit 0; fi; shift; done\nexit 1\n');
		await chmod(curl, 0o700);
		const child = Bun.spawn(["/bin/sh", path.join(root, "scripts/bootstrap.sh"), root, data, "fixture-host"], { env: { ...process.env, PATH: bin }, stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		expect(code).not.toBe(0);
		const state = JSON.parse(await readFile(path.join(data, "setup-state.json"), "utf8"));
		expect(state.status).toBe("failed");
		expect(state.message).toContain(failure === "download" ? "download failed" : "checksum verification failed");
		expect(stdout + stderr + JSON.stringify(state)).not.toContain("secret-download-token");
		expect(await readdir(path.join(data, "runtime"))).toEqual([]);
	}
}, 60_000);

test("failed frozen dependency install leaves no active package or ready claim", async () => {
	const directory = await fixture();
	const source = path.join(directory, "plugin");
	const data = path.join(directory, "data");
	await mkdir(path.join(source, "scripts"), { recursive: true });
	await mkdir(path.join(source, "src"));
	await writeFile(path.join(source, "package.json"), JSON.stringify({ name: "broken-fixture", files: ["plugin.toml", "bun.lock", "scripts", "src"] }));
	await writeFile(path.join(source, "bun.lock"), "not a lockfile");
	await writeFile(path.join(source, "plugin.toml"), "schema = 1\n");
	await writeFile(path.join(source, "src/cli.ts"), 'throw new Error("backend must not start");\n');
	for (const file of ["build.ts", "bootstrap.sh", "bootstrap.ps1"]) await cp(path.join(root, "scripts", file), path.join(source, "scripts", file));
	await expect(runFile(process.execPath, [path.join(source, "scripts/build.ts"), "bootstrap", source, data, "fixture-host"], { cwd: directory, timeout: 30_000 })).rejects.toThrow();
	const state = JSON.parse(await readFile(path.join(data, "setup-state.json"), "utf8"));
	expect(state).toMatchObject({ status: "failed", stage: "dependencies" });
	expect(state.message).toContain("Pinned dependency installation failed");
	expect(await readdir(path.join(data, "installation", "packages"))).toEqual([]);
	expect(await readdir(path.join(data, "installation"))).not.toContain("current.json");
	expect(await readdir(source)).not.toContain("node_modules");
}, 60_000);

test("bootstrap ownership automatically reclaims dead owners but never live owners", async () => {
	const directory = await fixture();
	const locks = path.join(directory, "bootstrap.lock");
	await mkdir(locks);
	const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"], { stdout: "ignore", stderr: "ignore" });
	await child.exited;
	await writeFile(path.join(locks, "dead.json"), JSON.stringify({ schema: 1, pid: child.pid, hostname: os.hostname(), processStartedAt: 1 }));
	const release = await acquireBootstrapLock(directory);
	expect(await readdir(locks)).not.toContain("dead.json");
	await expect(acquireBootstrapLock(directory)).rejects.toThrow("still running");
	await expect(acquireBootstrapLock(directory, true)).rejects.toThrow("still running");
	await release();
	expect(await readdir(locks)).toEqual([]);
});

test("unknown bootstrap ownership requires the explicit confirmed recovery flag", async () => {
	const directory = await fixture();
	const locks = path.join(directory, "bootstrap.lock");
	await mkdir(locks);
	await writeFile(path.join(locks, "unknown.json"), "{}");
	await expect(acquireBootstrapLock(directory)).rejects.toThrow("Confirm recovery");
	expect(await readdir(locks)).toEqual(["unknown.json"]);
	const release = await acquireBootstrapLock(directory, true);
	expect(await readdir(locks)).not.toContain("unknown.json");
	await release();
	expect(await readdir(locks)).toEqual([]);
});
