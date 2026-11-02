// SPDX-License-Identifier: MPL-2.0
import { lstat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { loadClientIdentity } from "./config.ts";
import type { ClientResumePlan } from "./client-resume.ts";
import { BridgeError } from "./protocol.ts";
import { inspectSetupPackage } from "./setup-payload.ts";
import { remotePath, setupCommand, shellArgument, sshCommand, validateHost } from "./setup-remote.ts";
import { privateDirectory, readOptionalJson } from "./setup-state.ts";

const AbsolutePath = z.string().min(1).max(32768).refine(value => path.isAbsolute(value) && path.resolve(value) === value && !/[\x00-\x1f\x7f]/.test(value));
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Config = z.object({ controlFile: AbsolutePath });
const CompletedSetup = z.object({ schema: z.literal(1), status: z.enum(["ready", "awaiting_session"]), host: z.string().min(1).max(255), controlFile: AbsolutePath, updatedAt: z.number().finite() });
const Installation = z.object({ schema: z.literal(1), packageRoot: AbsolutePath, fingerprint: Digest });
const ManagedClient = z.object({ schema: z.literal(1), kind: z.literal("client"), ownership: z.literal("managed"), pid: z.number().int().positive(), instance: z.string().uuid(), host: z.string().optional(), packageRoot: AbsolutePath.optional(), packageDigest: Digest.optional(), runtime: AbsolutePath.optional(), remoteCommand: z.string().min(1).max(32768).refine(value => !/[\x00-\x1f\x7f]/.test(value)).optional() });

export type LegacyClientInstallation = Omit<ClientResumePlan, "remoteCommand"> & { remoteCommand?: string; stamp: string };

/** Read-only evidence for a completed installation predating revocable recovery receipts. */
export async function inspectLegacyClientInstallation(pluginData: string): Promise<LegacyClientInstallation> {
	const data = path.resolve(pluginData);
	if (await readOptionalJson(path.join(data, "client-resume-initialized.json")) !== undefined) throw new BridgeError("CLIENT_RESUME_SETUP_REQUIRED", "Local recovery was previously initialized and its approval is now absent. Automatic migration will not restore revoked approval.");
	if (await readOptionalJson(path.join(data, "client-resume.json")) !== undefined) throw new BridgeError("CLIENT_RESUME_CONFLICT", "A recovery approval already exists; legacy migration must not replace it.");
	const config = Config.safeParse(await readOptionalJson(path.join(data, "config.json")));
	const progress = CompletedSetup.safeParse(await readOptionalJson(path.join(data, "setup-state.json")));
	const current = Installation.safeParse(await readOptionalJson(path.join(data, "installation", "current.json")));
	if (!config.success || !progress.success || !current.success) throw new BridgeError("CLIENT_RESUME_SETUP_REQUIRED", "No complete, verifiable earlier installation is available for automatic recovery.");
	if (config.data.controlFile !== progress.data.controlFile) throw new BridgeError("CLIENT_RESUME_CONFIG_CONFLICT", "The current client configuration differs from the completed installation.");
	const controlFile = config.data.controlFile;
	const stateDir = path.dirname(controlFile);
	if (path.basename(controlFile) !== "client.json" || stateDir === path.parse(stateDir).root) throw new BridgeError("CLIENT_RESUME_CONFIG_CONFLICT", "Legacy recovery requires the original dedicated client state directory.");
	validateHost(progress.data.host);
	const rawRecord = await readOptionalJson(path.join(stateDir, "client.managed.json"));
	const parsedRecord = rawRecord === undefined ? undefined : ManagedClient.safeParse(rawRecord);
	if (parsedRecord && !parsedRecord.success) throw new BridgeError("SERVICE_CONFLICT", "The existing client record does not establish managed ownership; it was not adopted.");
	const record = parsedRecord?.success ? parsedRecord.data : undefined;
	if (record && ((record.host !== undefined && record.host !== progress.data.host) || (record.packageRoot !== undefined && record.packageRoot !== current.data.packageRoot) || (record.packageDigest !== undefined && record.packageDigest !== current.data.fingerprint))) throw new BridgeError("CLIENT_RESUME_CONFLICT", "The managed client and completed installation disagree; neither was changed.");
	const packageRoot = current.data.packageRoot;
	if (packageRoot !== path.join(data, "installation", "packages", current.data.fingerprint)) throw new BridgeError("CLIENT_RESUME_PACKAGE_CONFLICT", "Legacy recovery requires the original private immutable installation package.");
	const packageInfo = await lstat(packageRoot);
	if (!packageInfo.isDirectory() || packageInfo.isSymbolicLink()) throw new BridgeError("CLIENT_RESUME_PACKAGE_CONFLICT", "The earlier installation package is not a real private directory.");
	const metadata = z.object({ name: z.literal("@jiwangyihao/tern-omp-client-bridge"), version: z.string() }).safeParse(await readOptionalJson(path.join(packageRoot, "package.json")));
	if (!metadata.success || Bun.semver.order(metadata.data.version, "0.5.0-beta.4") >= 0) throw new BridgeError("CLIENT_RESUME_SETUP_REQUIRED", "This installation already supports revocable recovery. Missing approval cannot be treated as a legacy installation.");
	const marker = z.object({ schema: z.literal(1), source: Digest, runtime: z.string() }).safeParse(await readOptionalJson(path.join(packageRoot, ".bridge-installation.json")));
	if (!marker.success || marker.data.source !== current.data.fingerprint || marker.data.runtime !== `${process.platform}-${process.arch}` || (await inspectSetupPackage(packageRoot)).digest !== current.data.fingerprint) throw new BridgeError("CLIENT_RESUME_PACKAGE_CONFLICT", "The earlier installation package no longer matches its verified installation record.");
	const savedIdentity = z.object({ device: z.object({ id: z.string().regex(/^client_[a-f0-9]{32}$/) }) }).safeParse(await readOptionalJson(path.join(stateDir, "identity.json")));
	if (!savedIdentity.success) throw new BridgeError("CLIENT_IDENTITY_REQUIRED", "The existing client identity is missing or invalid; automatic migration will not generate another identity.");
	const identity = await loadClientIdentity(stateDir, { expectedDeviceId: savedIdentity.data.device.id });
	if (identity.device.platform !== process.platform) throw new BridgeError("CLIENT_IDENTITY_CONFLICT", "The saved client identity belongs to a different platform.");
	const runtime = record?.runtime ?? process.execPath;
	const runtimeInfo = await lstat(runtime);
	if (!runtimeInfo.isFile() || runtimeInfo.isSymbolicLink()) throw new BridgeError("CLIENT_RESUME_PACKAGE_CONFLICT", "The earlier client runtime is not an available regular executable.");
	return {
		schema: 1, kind: "client-resume", host: progress.data.host, stateDir, controlFile,
		packageRoot, runtime, deviceId: identity.device.id, packageDigest: current.data.fingerprint,
		...(record?.remoteCommand === undefined ? {} : { remoteCommand: record.remoteCommand }),
		stamp: JSON.stringify([config.data, progress.data, current.data, record ?? null, identity.device.id]),
	};
}

/** Discover only the already-installed relay on the previously approved SSH host. */
async function discoverLegacyRelay(data: string, host: string): Promise<string> {
	await privateDirectory(data);
	const log = path.join(data, "client-recovery.log");
	const query = (argv: string[]) => setupCommand("ssh", sshCommand(host, argv), { log, timeout: 20000, message: "Cannot inspect the existing relay on the approved SSH host. No remote installation or service change was performed." });
	const output = await query(["sh", "-c", 'set -eu; printf \'%s\\n\' "$(uname -s)" "$HOME" "${XDG_STATE_HOME:-$HOME/.local/state}"; tern plugin dir --json']);
	const [system, homeValue, stateValue, ...catalogLines] = output.split(/\r?\n/);
	if ((system !== "Linux" && system !== "Darwin") || !homeValue || !stateValue) throw new BridgeError("CLIENT_RESUME_LEGACY_CONFLICT", "The approved host did not return supported native installation metadata.");
	const home = remotePath(homeValue);
	const stateHome = remotePath(stateValue);
	const catalog = z.object({ dir: z.string() }).parse(JSON.parse(catalogLines.join("\n")));
	const plugins = remotePath(catalog.dir);
	if (path.posix.basename(plugins) !== "plugins") throw new BridgeError("CLIENT_RESUME_LEGACY_CONFLICT", "The remote native plugin directory is not a recognized installation location.");
	const nativeState = system === "Darwin" ? path.posix.join(home, "Library", "Application Support", "Tern") : path.posix.join(stateHome, "tern");
	const candidates = new Set([
		path.posix.join(path.posix.dirname(plugins), "plugin-data", "omp-client-bridge", "config.json"),
		path.posix.join(nativeState, "plugin-data", "omp-client-bridge", "config.json"),
	]);
	async function readRemoteJson(file: string): Promise<unknown> {
		const text = await query(["sh", "-c", 'set -eu; if test -L "$1"; then exit 65; fi; if test -f "$1"; then cat "$1"; else printf null; fi', "bridge-existing-metadata", remotePath(file)]);
		return JSON.parse(text);
	}
	const controls = new Set<string>();
	for (const file of candidates) {
		const raw = await readRemoteJson(file);
		if (raw === null) continue;
		const config = z.object({ serverControlFile: z.string() }).parse(raw);
		const control = remotePath(config.serverControlFile);
		if (path.posix.basename(control) !== "server.json") throw new BridgeError("CLIENT_RESUME_LEGACY_CONFLICT", "Remote plugin metadata does not identify a broker control file.");
		controls.add(control);
	}
	if (controls.size !== 1) throw new BridgeError("CLIENT_RESUME_LEGACY_CONFLICT", "The approved host has missing or ambiguous broker metadata; automatic recovery will not guess a target.");
	const control = [...controls][0]!;
	const stateDir = path.posix.dirname(control);
	const record = z.object({ schema: z.literal(1), kind: z.literal("server"), ownership: z.literal("managed"), pid: z.number().int().positive(), packageRoot: z.string(), runtime: z.string() }).parse(await readRemoteJson(path.posix.join(stateDir, "server.managed.json")));
	const packageRoot = remotePath(record.packageRoot);
	const runtime = remotePath(record.runtime);
	const probe = `import { serviceHealth } from ${JSON.stringify(path.posix.join(packageRoot, "src", "setup-managed.ts"))}; const h = await serviceHealth("server", ${JSON.stringify(stateDir)}); console.log(JSON.stringify({ pid: h.endpoint.pid, connected: h.connected }));`;
	const health = z.object({ pid: z.number().int().positive(), connected: z.literal(true) }).parse(JSON.parse(await query([runtime, "-e", probe])));
	if (health.pid !== record.pid) throw new BridgeError("CLIENT_RESUME_LEGACY_CONFLICT", "The authenticated broker differs from its existing ownership record; no remote process was changed.");
	return [runtime, path.posix.join(packageRoot, "src", "cli.ts"), "relay", "--state-dir", stateDir].map(shellArgument).join(" ");
}

/** Revalidate local evidence after the bounded read-only SSH discovery, before adopting it. */
export async function recoverLegacyClientPlan(pluginData: string): Promise<ClientResumePlan> {
	const data = path.resolve(pluginData);
	const evidence = await inspectLegacyClientInstallation(data);
	const remoteCommand = evidence.remoteCommand ?? await discoverLegacyRelay(data, evidence.host);
	const current = await inspectLegacyClientInstallation(data);
	if (current.stamp !== evidence.stamp) throw new BridgeError("CLIENT_RESUME_CONFLICT", "The earlier installation changed during recovery discovery; no approval was written.");
	const { stamp: _stamp, remoteCommand: _previousCommand, ...plan } = evidence;
	return { ...plan, remoteCommand };
}
