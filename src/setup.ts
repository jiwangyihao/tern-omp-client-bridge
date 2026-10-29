// SPDX-License-Identifier: MPL-2.0
import path from "node:path";
import { z } from "zod";
import { installOmp, installTern, ternDirectories } from "../scripts/install.ts";
import { defaultStateDir, readEndpoint } from "./config.ts";
import { BridgeError } from "./protocol.ts";
import { ServerStateSchema } from "./schemas.ts";
import { ensureManagedService, ManagedResultSchema, serviceHealth } from "./setup-managed.ts";
import { detectRemote, packageArchive, remotePath, setupCommand, shellArgument, sshCommand, stageRemote, validateHost } from "./setup-remote.ts";
import { acquireSetupLock, mergeControlFile, privateDirectory, readOptionalJson, writeSetupProgress } from "./setup-state.ts";
import { setupReadiness, ternReloadReadiness, type PluginReloadStatus } from "./setup-readiness.ts";
import { resolveTernExecutable } from "./tern-executable.ts";
import { resolveTernPaneSocket } from "./tern-routing.ts";

export interface SetupOptions {
	host: string;
	pluginData: string;
	packageRoot: string;
	remoteRoot?: string;
	agentDir?: string;
	ternDir?: string;
	/** This client's native executable; never forwarded to the agent host. */
	ternExecutable?: string;
	/** This client's native daemon route; never forwarded to the agent host. */
	ternPaneSocket?: string;
}

const AgentResultSchema = z.object({
	kind: z.literal("agent-setup"), root: z.string(), packageRoot: z.string(), runtime: z.string(),
	ompLoader: z.string(), ternPlugin: z.string(), ternConfig: z.string(),
	pluginReload: z.enum(["reloaded", "unavailable", "failed", "isolated"]), broker: ManagedResultSchema,
	pluginReloadMessage: z.string().max(256).optional(),
});
export const SetupResultSchema = z.object({
	schema: z.literal(1), kind: z.literal("setup-complete"), status: z.enum(["awaiting_session", "ready"]),
	stage: z.string(), host: z.string(), controlFile: z.string(), message: z.string(), remote: AgentResultSchema,
	client: ManagedResultSchema,
});
export type SetupResult = z.infer<typeof SetupResultSchema>;

/** Runs on the agent host from a durable, dependency-complete private release. */
export async function setupAgent(options: { remoteRoot: string; packageRoot: string; agentDir?: string; ternDir?: string; ternExecutable?: string; ternPaneSocket?: string }): Promise<z.infer<typeof AgentResultSchema>> {
	if (process.platform !== "linux" && process.platform !== "darwin") throw new BridgeError("UNSUPPORTED_HOST", "Managed agent-host setup requires POSIX Linux or macOS.");
	const root = remotePath(options.remoteRoot);
	await privateDirectory(root);
	const release = await acquireSetupLock(path.join(root, "agent-setup.lock"));
	try {
		// The configured loader uses a BrokerClient option, never process-wide environment mutation.
		const omp = await installOmp(options.agentDir, { stateDir: root });
		const tern = await installTern({ target: options.ternDir, controlFile: path.join(root, "client.json"), ternExecutable: options.ternExecutable, ternPaneSocket: options.ternPaneSocket });
		const broker = await ensureManagedService({ kind: "server", stateDir: root, packageRoot: options.packageRoot });
		let pluginReload: PluginReloadStatus = options.ternDir ? "isolated" : "unavailable";
		let pluginReloadMessage = options.ternDir ? "Host plugin reload is unverified for this isolated directory. Reload its intended Tern daemon explicitly, then retry." : "Native Tern plugin reload is unavailable. Open the intended Tern daemon, verify omp-client-bridge is ready and retry.";
		// An isolated config directory does not identify a daemon socket. Never reload the default daemon for it.
		if (!options.ternDir) {
			const log = path.join(root, "setup.log");
			let help = "";
			try { help = await setupCommand(tern.ternExecutable, ["plugin", "--help"], { log, timeout: 10000, message: "Tern plugin reload is unavailable on this agent host." }); } catch { /* Installation remains usable for a newly opened Tern session. */ }
			if (/tern plugin reload/.test(help)) {
				try {
					const output = await setupCommand(tern.ternExecutable, ["plugin", "reload", "--json"], { log, logStdout: true, timeout: 30000, message: "Tern plugins could not be reloaded; reload them explicitly in the intended Tern daemon." });
					const readiness = ternReloadReadiness(JSON.parse(output));
					pluginReload = readiness.status;
					pluginReloadMessage = readiness.message;
				} catch {
					pluginReload = "failed";
					pluginReloadMessage = "Tern host plugin reload failed or returned invalid JSON. Inspect its private host setup log and native plugin list, resolve the load problem and retry.";
				}
			}
		}
		return { kind: "agent-setup", root, packageRoot: options.packageRoot, runtime: process.execPath, ompLoader: omp.loader, ternPlugin: tern.plugin, ternConfig: tern.config, pluginReload, pluginReloadMessage, broker };
	} finally { await release(); }
}

/** Confirms the same signed device is registered on the selected agent host, not another broker. */
export async function setupRegistration(stateDir: string, deviceId: string): Promise<{ registered: boolean; deviceId: string }> {
	const endpoint = await readEndpoint(path.join(stateDir, "server.json"));
	const response = await fetch(endpoint.url + "/v1/state?sessionId=bridge-setup-readiness", {
		headers: { authorization: `Bearer ${endpoint.token}` }, redirect: "error", signal: AbortSignal.timeout(5000),
	});
	if (!response.ok) throw new BridgeError("BROKER_NOT_READY", "The selected broker rejected authenticated registration verification.");
	const state = ServerStateSchema.parse(await response.json());
	return { registered: state.devices.some(device => device.id === deviceId && device.online), deviceId };
}

/** The plugin's explicit consent is the entrypoint; importing/loading this module performs no setup. */
export async function setup(options: SetupOptions): Promise<SetupResult> {
	validateHost(options.host);
	for (const value of [options.remoteRoot, options.agentDir, options.ternDir]) if (value !== undefined) remotePath(value);
	const data = path.resolve(options.pluginData);
	const packageRoot = path.resolve(options.packageRoot);
	await privateDirectory(data);
	const release = await acquireSetupLock(path.join(data, "setup.lock"));
	let stage = "checking-local-cli";
	const progress = async (next: string, message: string) => {
		stage = next;
		await writeSetupProgress(data, { status: "installing", stage, message, host: options.host });
	};
	try {
		const log = path.join(data, "setup.log");
		await progress("checking-local-cli", "Locating this device's native Tern executable before changing services.");
		const config = await readOptionalJson(path.join(data, "config.json"));
		const parsedConfig = config === undefined ? {} : z.record(z.string(), z.unknown()).parse(config);
		const ternExecutable = await resolveTernExecutable({ explicit: options.ternExecutable, saved: parsedConfig.ternExecutable });
		const ternPaneSocket = await resolveTernPaneSocket({ explicit: options.ternPaneSocket, saved: parsedConfig.ternPaneSocket, configDirectory: ternDirectories().config });
		await progress("checking-ssh", "Checking the selected trusted SSH host and its platform; no host-key or password prompts are bypassed.");
		const remote = await detectRemote(options.host, log, options.remoteRoot);
		await progress("staging-package", "Staging the bridge in a durable private directory on the agent host and preparing compatible runtime dependencies.");
		const source = await packageArchive(packageRoot, data, log);
		const installed = await stageRemote(options.host, remote, source, log);
		await progress("installing-remote", "Installing the native OMP extension and Tern host plugin; starting or reusing the authenticated broker without restarting OMP sessions.");
		const remoteCli = [installed.bun, path.posix.join(installed.packageRoot, "src", "cli.ts")];
		const agentArgs = [...remoteCli, "setup-agent", "--remote-root", remote.root, "--package-root", installed.packageRoot];
		if (options.agentDir) agentArgs.push("--agent-dir", options.agentDir);
		if (options.ternDir) agentArgs.push("--tern-dir", options.ternDir);
		const agent = AgentResultSchema.parse(JSON.parse(await setupCommand("ssh", sshCommand(options.host, agentArgs), { log, timeout: 180000, message: "Remote bridge installation or broker startup failed. Inspect the private setup log and any existing service owner, then retry. No OMP session was restarted." })));
		if (agent.root !== remote.root || agent.packageRoot !== installed.packageRoot || agent.broker.stateDir !== remote.root) throw new BridgeError("REMOTE_STATE_CONFLICT", "The remote installer returned a different broker state directory; no local client was started.");
		await progress("starting-client", "Starting or reusing this device's private client and completing signed registration. Existing device identity is retained.");
		let stateDir = path.join(data, "bridge");
		if (parsedConfig.controlFile !== undefined) {
			if (typeof parsedConfig.controlFile !== "string" || !path.isAbsolute(parsedConfig.controlFile) || path.basename(parsedConfig.controlFile) !== "client.json") throw new BridgeError("SETUP_CONFIG_CONFLICT", "The saved controlFile is not an absolute client.json path. Correct that setting explicitly before setup can repair it.");
			stateDir = path.dirname(parsedConfig.controlFile);
		} else if (await readOptionalJson(path.join(defaultStateDir(), "identity.json")) !== undefined) {
			// Adopt an earlier manual installation without generating another identity/registration.
			stateDir = defaultStateDir();
		}
		const relay = [...remoteCli, "relay", "--state-dir", remote.root].map(shellArgument).join(" ");
		const client = await ensureManagedService({ kind: "client", stateDir, packageRoot, host: options.host, remoteCommand: relay });
		await progress("checking-registration", "Verifying this signed client on the selected broker before saving the plugin connection.");
		const registration = z.object({ registered: z.literal(true), deviceId: z.string() }).safeParse(JSON.parse(await setupCommand("ssh", sshCommand(options.host, [...remoteCli, "setup-status", "--state-dir", remote.root, "--device-id", client.deviceId!]), { log, message: "Could not verify this client's signed registration on the selected broker. Check SSH access and retry." })));
		if (!registration.success || registration.data.deviceId !== client.deviceId) throw new BridgeError("CLIENT_HOST_CONFLICT", "This local client is not registered on the selected broker. It may still belong to another host; use its original configuration or stop it explicitly before retrying. Setup did not replace it.");
		const health = await serviceHealth("client", stateDir);
		if (!health.connected || health.deviceId !== client.deviceId) throw new BridgeError("CLIENT_NOT_READY", "The signed client disconnected before setup completed. Check SSH connectivity and retry; the plugin configuration was not changed.");
		await mergeControlFile(data, client.controlFile, ternExecutable, ternPaneSocket);
		const completion = setupReadiness({ sessionReady: health.sessionReady, pluginReload: agent.pluginReload, pluginReloadMessage: agent.pluginReloadMessage, client, broker: agent.broker });
		await writeSetupProgress(data, { ...completion, host: options.host, controlFile: client.controlFile });
		return SetupResultSchema.parse({ schema: 1, kind: "setup-complete", status: completion.status, stage: completion.stage, host: options.host, controlFile: client.controlFile, message: completion.message, remote: agent, client: { ...client, sessionReady: health.sessionReady } });
	} catch (error) {
		const known = error instanceof BridgeError;
		await writeSetupProgress(data, { status: "failed", stage, host: options.host, error: known ? error.code.slice(0, 128) : "SETUP_FAILED", message: known ? error.message.slice(0, 1024) : "Setup could not finish. Inspect private setup/service logs, package completeness, path permissions and trusted SSH access, then retry the same setup to repair it." });
		throw error;
	} finally { await release(); }
}
