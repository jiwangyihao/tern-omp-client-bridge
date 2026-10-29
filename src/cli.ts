#!/usr/bin/env bun
// SPDX-License-Identifier: MPL-2.0
import path from "node:path";
import { z } from "zod";
import { assertSupportedRuntime, defaultStateDir, loadClientIdentity } from "./config.ts";
import { BridgeError } from "./protocol.ts";
import { startBroker } from "./broker.ts";
import { startClientService } from "./client.ts";
import { runRelay } from "./relay.ts";
import { installOmp, installTern } from "../scripts/install.ts";
import { setup, setupAgent, setupRegistration } from "./setup.ts";
import { ensureManagedService, runManagedService } from "./setup-managed.ts";

const HELP = `Usage: tern-omp-bridge COMMAND [OPTIONS]

  setup --host SSH_ALIAS --plugin-data PATH --package-root PATH
        [--remote-root POSIX_PATH] [--agent-dir POSIX_PATH] [--tern-dir POSIX_PATH]
        [--tern-executable ABSOLUTE_LOCAL_PATH] [--tern-pane-socket ABSOLUTE_LOCAL_PATH]
  server [--state-dir PATH] [--port N]
  relay [--state-dir PATH]
  client --host SSH_ALIAS
         [--name NAME] [--state-dir PATH] [--cwd PATH]
         [--remote-command COMMAND]
  install-omp [--target AGENT_DIRECTORY] [--state-dir PATH]
  install-tern [--target TERN_DIRECTORY] [--control-file PATH] [--tern-executable ABSOLUTE_PATH]
               [--tern-pane-socket ABSOLUTE_LOCAL_PATH]
  help | --help | -h

The normal flow is Tern's consented Set up Bridge command, which invokes setup.
Setup provisions private compatible runtimes/packages and owned detached services;
manual session binding authorizes client tools under native policy and OS permissions.
It never installs globally, bypasses SSH host trust, or restarts OMP sessions.
--remote-root isolates remote broker/runtime/package state; --agent-dir and
--tern-dir isolate native host installations. All three overrides are remote
absolute POSIX paths. A connected client is awaiting_session until a real view
handshake; plugin-data/setup-state.json contains bounded public progress.

Install this package on BOTH the client device and agent host. Run server on
that host; its authenticated loopback endpoint is required by relay and OMP.
Bridge services require Bun 1.4.3 or newer for correct awaited socket shutdown.
The user must establish/trust the SSH host key before starting client. Client
uses outbound SSH without agent forwarding; default remote command is
"tern-omp-bridge relay". An offline client does not replay operations.

Ports must be integers from 1 to 65535; omission selects an ephemeral port.
Foreground server/client/relay commands stop on stdin EOF or SIGINT/SIGTERM.

install-omp verifies its candidate with the installed omp executable on PATH in
an isolated, no-prompt host before replacing extensions/tern-omp-client-bridge/index.ts
under the native OMP agent directory (or --target). Keep this package installed.
It never activates bridge lifecycle handlers, contacts the broker, or restarts an existing OMP.
install-tern copies the plugin and merges connection metadata plus this machine's
absolute Tern CLI path and native daemon socket. --tern-executable overrides
executable discovery; --tern-pane-socket sets the native control route explicitly.
Setup's local overrides are never forwarded to the remote host. An isolated
--target needs an explicit socket before its window plugin can initialize PiP.
Run install-tern on the client AND the remote Tern host: the right-side Bridge
panel is a native host block, while its controls and clipboard stay on the client.
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
	client: ["host", "name", "state-dir", "cwd", "remote-command"],
	"install-omp": ["target", "state-dir"],
	"install-tern": ["target", "control-file", "tern-executable", "tern-pane-socket"],
	setup: ["host", "plugin-data", "package-root", "remote-root", "agent-dir", "tern-dir", "tern-executable", "tern-pane-socket"],
	"setup-agent": ["remote-root", "package-root", "agent-dir", "tern-dir", "tern-executable", "tern-pane-socket"],
	"setup-status": ["state-dir", "device-id"],
	"managed-start": ["kind", "state-dir", "package-root", "host", "remote-command"],
	"managed-service": ["kind", "state-dir", "package-root", "host", "remote-command"],
};

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
	function required(key: string): string {
		const value = options.get(key);
		if (!value) throw new BridgeError("USAGE", `${command} requires --${key}`);
		return value;
	}
	switch (command) {
		case "setup": {
			console.log(JSON.stringify(await setup({ host: required("host"), pluginData: required("plugin-data"), packageRoot: required("package-root"), remoteRoot: options.get("remote-root"), agentDir: options.get("agent-dir"), ternDir: options.get("tern-dir"), ternExecutable: options.get("tern-executable"), ternPaneSocket: options.get("tern-pane-socket") })));
			return;
		}
		case "setup-agent": {
			console.log(JSON.stringify(await setupAgent({ remoteRoot: required("remote-root"), packageRoot: required("package-root"), agentDir: options.get("agent-dir"), ternDir: options.get("tern-dir"), ternExecutable: options.get("tern-executable"), ternPaneSocket: options.get("tern-pane-socket") })));
			return;
		}
		case "setup-status": {
			console.log(JSON.stringify(await setupRegistration(path.resolve(required("state-dir")), required("device-id"))));
			return;
		}
		case "managed-start":
		case "managed-service": {
			const kind = z.enum(["server", "client"]).safeParse(required("kind"));
			if (!kind.success) throw new BridgeError("USAGE", "--kind must be server or client");
			const managed = { kind: kind.data, stateDir: path.resolve(required("state-dir")), packageRoot: path.resolve(required("package-root")), host: options.get("host"), remoteCommand: options.get("remote-command") };
			if (command === "managed-start") console.log(JSON.stringify(await ensureManagedService(managed)));
			else await runManagedService(managed);
			return;
		}
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
			await serve(async () => {
				const identity = await loadClientIdentity(stateDir, options.has("name") ? { name: options.get("name")! } : {});
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
			console.log(JSON.stringify(await installOmp(options.get("target"), options.has("state-dir") ? { stateDir } : {})));
			return;
		}
		case "install-tern": {
			console.log(JSON.stringify(await installTern({ target: options.get("target"), controlFile: options.get("control-file"), ternExecutable: options.get("tern-executable"), ternPaneSocket: options.get("tern-pane-socket") })));
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
