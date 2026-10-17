#!/usr/bin/env bun
// SPDX-License-Identifier: MPL-2.0
import path from "node:path";
import { z } from "zod";
import { assertSupportedRuntime, defaultStateDir, loadClientIdentity } from "./config.ts";
import { BridgeError } from "./protocol.ts";
import type { Capability } from "./protocol.ts";
import { startBroker } from "./broker.ts";
import { startClientService } from "./client.ts";
import { runRelay } from "./relay.ts";
import { installOmp, installTern } from "../scripts/install.ts";

const HELP = `Usage: tern-omp-bridge COMMAND [OPTIONS]

  server [--state-dir PATH] [--port N]
  relay [--state-dir PATH]
  client --host SSH_ALIAS --allow files,exec,computer,browser,adb|none
         [--name NAME] [--state-dir PATH] [--cwd PATH]
         [--remote-command COMMAND]
  install-omp [--target AGENT_DIRECTORY]
  install-tern [--target TERN_DIRECTORY] [--control-file PATH]
  help | --help | -h

Install this package on BOTH the client device and agent host. Run server on
that host; its authenticated loopback endpoint is required by relay and OMP.
Bridge services require Bun 1.4.3 or newer for correct awaited socket shutdown.
The user must establish/trust the SSH host key before starting client. Client
uses outbound SSH without agent forwarding; default remote command is
"tern-omp-bridge relay". An offline client does not replay operations.

--allow is required on every client start; none enables human transfers only.
Ports must be integers from 1 to 65535; omission selects an ephemeral port.
Long-running commands stop on stdin EOF or SIGINT/SIGTERM.

install-omp writes only extensions/tern-omp-client-bridge/index.ts under the
native OMP agent directory (or --target). Keep this package installed there.
install-tern copies the actual plugin and merges only its controlFile setting.
--target isolates BOTH Tern config and plugin data beneath that directory;
without it the native platform config/state directories are used.
--control-file defaults to the local bridge state directory's client.json,
never identity.json. Existing global settings and other plugins are untouched.
Reload Tern plugins / restart OMP yourself after installation. These commands
never install/start background services or change unrelated settings.
`;

const OPTIONS: Record<string, readonly string[]> = {
	server: ["state-dir", "port"],
	relay: ["state-dir"],
	client: ["host", "allow", "name", "state-dir", "cwd", "remote-command"],
	"install-omp": ["target"],
	"install-tern": ["target", "control-file"],
};
const CapabilitySchema = z.enum(["files", "exec", "computer", "browser", "adb"]);

function argumentsFor(command: string, args: string[]): Map<string, string> {
	const allowed = OPTIONS[command];
	if (!allowed) throw new BridgeError("USAGE", "Unknown command; use --help");
	const result = new Map<string, string>();
	for (let index = 0; index < args.length; index++) {
		const flag = args[index]!;
		if (!flag.startsWith("--") || !allowed.includes(flag.slice(2))) throw new BridgeError("USAGE", "Unknown argument; use --help");
		const key = flag.slice(2);
		if (result.has(key)) throw new BridgeError("USAGE", `Duplicate --${key}`);
		const value = args[++index];
		if (!value || value.startsWith("--") || value.includes("\0")) throw new BridgeError("USAGE", `--${key} requires a nonempty value`);
		result.set(key, value);
	}
	return result;
}

function capabilities(value: string | undefined): Capability[] {
	if (value === undefined) throw new BridgeError("USAGE", "client requires explicit --allow capabilities or --allow none");
	if (value === "none") return [];
	const parsed = z.array(CapabilitySchema).nonempty().safeParse(value.split(","));
	if (!parsed.success) throw new BridgeError("USAGE", "--allow must contain files,exec,computer,browser,adb or exactly none");
	if (new Set(parsed.data).size !== parsed.data.length) throw new BridgeError("USAGE", "--allow contains duplicate capabilities");
	return parsed.data;
}

interface RunningService {
	endpoint: { url: string };
	close(): Promise<void>;
}

/** Start listeners before asynchronous setup so an early interrupt still closes the owned service. */
async function serve(start: () => Promise<RunningService>, kind: string): Promise<void> {
	const stopped = Promise.withResolvers<void>();
	let signalCode: number | undefined;
	const onEnd = () => stopped.resolve();
	const onInterrupt = () => { signalCode = 130; stopped.resolve(); };
	const onTerminate = () => { signalCode = 143; stopped.resolve(); };
	const onInputError = () => { signalCode = 1; stopped.resolve(); };
	process.once("SIGINT", onInterrupt);
	process.once("SIGTERM", onTerminate);
	process.stdin.once("end", onEnd);
	process.stdin.once("error", onInputError);
	process.stdin.resume();
	if (process.stdin.readableEnded) stopped.resolve();
	let service: RunningService | undefined;
	try {
		service = await start();
		console.log(JSON.stringify({ kind, url: service.endpoint.url }));
		await stopped.promise;
	} finally {
		try { await service?.close(); }
		finally {
			process.off("SIGINT", onInterrupt);
			process.off("SIGTERM", onTerminate);
			process.stdin.off("end", onEnd);
			process.stdin.off("error", onInputError);
			process.stdin.pause();
			if (signalCode !== undefined) process.exitCode = signalCode;
		}
	}
}

export async function main(args = process.argv.slice(2)): Promise<void> {
	const command = args[0];
	if (command === undefined || ((command === "help" || command === "--help" || command === "-h") && args.length === 1)) {
		console.log(HELP);
		return;
	}
	if (OPTIONS[command] && args.length === 2 && (args[1] === "--help" || args[1] === "-h")) { console.log(HELP); return; }
	const options = argumentsFor(command, args.slice(1));
	assertSupportedRuntime();
	const stateDir = path.resolve(options.get("state-dir") ?? defaultStateDir());
	switch (command) {
		case "server": {
			const rawPort = options.get("port");
			const port = rawPort === undefined ? undefined : Number(rawPort);
			if (rawPort !== undefined && (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port! < 1 || port! > 65535)) throw new BridgeError("USAGE", "--port must be an integer from 1 to 65535");
			await serve(() => startBroker({ stateDir, ...(port === undefined ? {} : { port }) }), "broker-ready");
			return;
		}
		case "client": {
			const host = options.get("host");
			if (!host || host.startsWith("-") || /\s/.test(host)) throw new BridgeError("USAGE", "client requires --host with one SSH host alias");
			const allowed = capabilities(options.get("allow"));
			await serve(async () => {
				const identity = await loadClientIdentity(stateDir, { capabilities: allowed, ...(options.has("name") ? { name: options.get("name")! } : {}) });
				return startClientService({
					identity, stateDir, serverName: host,
					...(options.has("cwd") ? { cwd: path.resolve(options.get("cwd")!) } : {}),
					connection: { kind: "ssh", host, remoteCommand: options.get("remote-command") ?? "tern-omp-bridge relay" },
				});
			}, "client-ready");
			return;
		}
		case "relay": {
			const controller = new AbortController();
			const interrupt = () => { process.exitCode = 130; controller.abort(new BridgeError("CANCELLED", "Relay interrupted")); };
			const terminate = () => { process.exitCode = 143; controller.abort(new BridgeError("CANCELLED", "Relay terminated")); };
			process.once("SIGINT", interrupt);
			process.once("SIGTERM", terminate);
			try { await runRelay({ stateDir, signal: controller.signal }); }
			catch (error) { if (!controller.signal.aborted) throw error; }
			finally { process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); }
			return;
		}
		case "install-omp": {
			console.log(JSON.stringify(await installOmp(options.get("target"))));
			return;
		}
		case "install-tern": {
			console.log(JSON.stringify(await installTern({ target: options.get("target"), controlFile: options.get("control-file") })));
			return;
		}
	}
}

if (import.meta.main) {
	try { await main(); }
	catch (error) {
		// Never print native/network errors that may contain bearer headers or identity material.
		console.error(error instanceof BridgeError ? `${error.code}: ${error.message}` : "Bridge command failed; check paths, permissions, dependencies and service availability.");
		process.exitCode = 1;
	}
}
