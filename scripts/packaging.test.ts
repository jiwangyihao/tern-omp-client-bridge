// SPDX-License-Identifier: MPL-2.0
import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { startBroker } from "../src/broker.ts";
import { BrokerClient } from "../src/broker-client.ts";
import { loadClientIdentity, signIdentity } from "../src/config.ts";
import { JsonLineDecoder, RpcPeer, WireFrameSchema } from "../src/wire.ts";
import { runRelay } from "../src/relay.ts";

const runFile = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const cli = path.join(root, "src", "cli.ts");
const roots: string[] = [];
const ChallengeSchema = z.object({ nonce: z.string() });
const ReceiptSchema = z.object({ id: z.string(), frame: z.string(), expiresAt: z.number() });
const ConfigSchema = z.object({ controlFile: z.string(), preserved: z.string() });
const InstallSchema = z.object({ kind: z.string(), loader: z.string().optional(), plugin: z.string().optional(), config: z.string().optional(), controlFile: z.string().optional() });

async function fixture(): Promise<string> {
	const directory = await mkdtemp(path.join(os.tmpdir(), "tern-bridge-packaging-"));
	roots.push(directory);
	return directory;
}

async function command(args: string[], directory: string) {
	return runFile(process.execPath, [cli, ...args], {
		cwd: directory, timeout: 30_000, maxBuffer: 1024 * 1024,
		env: { ...process.env, PI_CODING_AGENT_DIR: path.join(directory, "native-agent"), TERN_OMP_BRIDGE_HOME: path.join(directory, "bridge-state") },
	});
}

afterEach(async () => { for (const directory of roots.splice(0)) await rm(directory, { recursive: true, force: true }); });

test("help and strict argument errors are finite and do not create bridge identity", async () => {
	const directory = await fixture();
	const help = await command(["--help"], directory);
	expect(help.stdout).toContain("Install this package on BOTH");
	expect(help.stdout).toContain("client.json");
	for (const args of [["unknown"], ["server", "--port", "0"], ["server", "--port", "65536"], ["client", "--host", "fixture-host"], ["client", "--host", "fixture-host", "--allow", "files,other"], ["install-tern", "--unknown", "x"]]) {
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
		const installed = path.join(tern, "plugins", "omp-client-bridge");
		for (const file of ["plugin.toml", "window.luau", "bridge.css"]) expect(await readFile(path.join(installed, file))).toEqual(await readFile(path.join(root, "tern", file)));
		const config = ConfigSchema.parse(JSON.parse(await readFile(path.join(data, "config.json"), "utf8")));
		expect(config).toEqual({ preserved: "unchanged", controlFile: control });
		expect(await readFile(path.join(tern, "settings.json"), "utf8")).toBe(settings);
		const native = InstallSchema.parse(JSON.parse((await command(["install-omp", "--target", omp], directory)).stdout));
		expect(native.loader).toBe(path.join(omp, "extensions", "tern-omp-client-bridge", "index.ts"));
		// This intentionally exercises the native loader module boundary, not source-text matching.
		const loaded = await import(native.loader!);
		expect(typeof loaded.default).toBe("function");
	}
	expect(await readFile(path.join(omp, "settings.json"), "utf8")).toBe("{\"unrelated\":true}\n");
	expect(await readFile(path.join(omp, "extensions", "unrelated.ts"), "utf8")).toBe("export default () => {};\n");
	expect(await readdir(directory)).not.toContain("bridge-state");
}, 120_000);

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
	const first = await loadClientIdentity(state, { name: "Synthetic fixture", capabilities: [] });
	const second = await loadClientIdentity(state, { capabilities: [] });
	expect(second.device.id).toBe(first.device.id);
	const file = path.join(state, "identity.json");
	if (process.platform === "win32") {
		const acl = await runFile("icacls", [file], { windowsHide: true });
		expect(acl.stdout).not.toContain("(I)");
		// Verify numeric broad-group SIDs too, independent of the runner's UI language.
		const rules = await runFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$a=Get-Acl -LiteralPath $env.BRIDGE_ACL_TEST_FILE; $a.Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value }"], { env: { ...process.env, BRIDGE_ACL_TEST_FILE: file }, windowsHide: true });
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
	const identity = await loadClientIdentity(path.join(directory, "client"), { name: "Relay fixture", capabilities: [] });
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
		const receipt = ReceiptSchema.parse(await peer.request("ui.intent", { kind: "resolve", viewId: "fixture-window:pane" }));
		expect(receipt.frame).not.toBe("");
		const claimed = await broker.claimIntent(receipt.id, "fixture-session", "fixture-draft");
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
