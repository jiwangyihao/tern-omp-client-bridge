// SPDX-License-Identifier: MPL-2.0
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { ClientResumePlanSchema, validateClientResumeLaunch, type ClientResumePlan } from "./client-resume.ts";
import { loadClientIdentity } from "./config.ts";
import { BridgeError } from "./protocol.ts";
import { inspectSetupPackage } from "./setup-payload.ts";
import { processExists, readOptionalJson } from "./setup-state.ts";
import { serviceHealth, type ManagedOptions } from "./setup-managed.ts";

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Owner = z.object({ schema: z.literal(1), kind: z.literal("client"), ownership: z.literal("managed"), pid: z.number().int().positive(), instance: z.string().uuid(), startedAt: z.number().finite().positive(), host: z.string(), packageRoot: z.string(), runtime: z.string(), packageDigest: Digest });
const Lock = z.object({ schema: z.literal(1), pid: z.number().int().positive(), instance: z.string().uuid() });
type Owner = z.infer<typeof Owner>;
export interface LegacyProcessEvidence { uid: number; startedAt: number; command: string; executable: string; listenerPid: number }
export interface LegacyMigrationSystem {
	inspectProcess(plan: ClientResumePlan, owner: Owner, port: string): Promise<LegacyProcessEvidence>;
	terminate(pid: number): void;
	exists(pid: number): boolean;
	sleep(ms: number): Promise<void>;
	now(): number;
}
const execute = promisify(execFile);
async function inspectProcess(_plan: ClientResumePlan, owner: Owner, port: string): Promise<LegacyProcessEvidence> {
	if (process.platform !== "darwin" && process.platform !== "linux") throw new BridgeError("CLIENT_MIGRATION_UNSUPPORTED", "Explicit legacy migration requires POSIX ps/lsof process ownership evidence. No signal was sent; use the original service manager on this platform.");
	async function query(binary: string, args: string[]): Promise<string> {
		try { return (await execute(binary, args, { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024, env: { ...process.env, LC_ALL: "C" } })).stdout.trim(); }
		catch { throw new BridgeError("CLIENT_MIGRATION_OWNERSHIP", "Cannot obtain OS process ownership evidence with ps/lsof; no signal was sent."); }
	}
	const ps = process.platform === "darwin" ? "/bin/ps" : "/usr/bin/ps";
	const lsof = process.platform === "darwin" ? "/usr/sbin/lsof" : "/usr/bin/lsof";
	const pid = String(owner.pid);
	const [uid, start, command, images, listeners] = await Promise.all([
		query(ps, ["-p", pid, "-o", "uid="]), query(ps, ["-p", pid, "-o", "lstart="]), query(ps, ["-ww", "-p", pid, "-o", "command="]),
		process.platform === "linux" ? readlink(`/proc/${pid}/exe`).then(file => `n${file}`).catch(() => { throw new BridgeError("CLIENT_MIGRATION_OWNERSHIP", "Cannot authenticate the Linux process executable through /proc; no signal was sent."); }) : query(lsof, ["-a", "-p", pid, "-d", "txt", "-Fn"]),
		query(lsof, ["-nP", "-a", "-p", pid, `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"]),
	]);
	const runtime = await realpath(owner.runtime);
	const executable = images.split("\n").filter(line => line.startsWith("n")).map(line => line.slice(1)).find(file => file === runtime);
	const listenerPids = listeners.split("\n").filter(line => line.startsWith("p")).map(line => Number(line.slice(1)));
	if (!executable || listenerPids.length !== 1) throw new BridgeError("CLIENT_MIGRATION_OWNERSHIP", "The recorded runtime does not own the authenticated listener; no signal was sent.");
	return { uid: Number(uid), startedAt: Date.parse(start), command, executable, listenerPid: listenerPids[0]! };
}
const system: LegacyMigrationSystem = { inspectProcess, terminate: pid => { process.kill(pid, "SIGTERM"); }, exists: processExists, sleep: ms => Bun.sleep(ms), now: () => Date.now() };

/** Legacy has no process attestation API. Require independent OS start/executable/listener evidence. */
export function assertLegacyProcessOwnership(plan: ClientResumePlan, owner: Owner, evidence: LegacyProcessEvidence, runtime: string, pluginData: string): void {
	if (typeof process.getuid !== "function" || evidence.uid !== process.getuid() || evidence.listenerPid !== owner.pid || evidence.executable !== runtime || !Number.isFinite(evidence.startedAt) || evidence.startedAt > owner.startedAt || owner.startedAt - evidence.startedAt > 120000) throw new BridgeError("CLIENT_MIGRATION_OWNERSHIP", "The managed record does not match the OS process owner/start instance/executable/listener; no signal was sent.");
	const base = [owner.runtime, path.join(owner.packageRoot, "src", "cli.ts"), "managed-service", "--kind", "client", "--state-dir", plan.stateDir, "--package-root", owner.packageRoot, "--host", plan.host, "--remote-command", plan.remoteCommand].join(" ");
	// These are the exact launch forms shipped before the lifecycle endpoint, not substring matches.
	const device = ` --expected-device-id ${plan.deviceId}`;
	const digest = ` --expected-package-digest ${owner.packageDigest}`;
	const resume = ` --resume-plugin-data ${pluginData}`;
	const commands = [base, base + device, base + device + digest, base + device + digest + resume];
	if (!commands.includes(evidence.command)) throw new BridgeError("CLIENT_MIGRATION_OWNERSHIP", "The OS command does not match the approved managed client launch; no signal was sent.");
}

export const LEGACY_MIGRATION_WARNING = "The legacy client cannot prove that it has no owned contexts, active operations or transfers. Graceful migration may interrupt them and discard client-side context state. This does not restart OMP sessions or the broker. Review the exact process and package, then explicitly acknowledge context loss; no force kill is permitted.";

/** Read-only preview. The confirmation binds the grant, endpoint secret hash, OS start and candidate. */
export async function inspectLegacyClientMigration(pluginData: string, dependencies: LegacyMigrationSystem = system) {
	const data = path.resolve(pluginData);
	const approval = ClientResumePlanSchema.safeParse(await readOptionalJson(path.join(data, "client-resume.json")));
	if (!approval.success) throw new BridgeError("CLIENT_RESUME_SETUP_REQUIRED", "Explicit migration requires the existing current recovery approval. Missing or revoked approval must be reviewed with explicit setup first.");
	const plan = approval.data;
	const candidateRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
	const candidateDigest = (await inspectSetupPackage(candidateRoot)).digest;
	const approvalDigest = createHash("sha256").update(JSON.stringify(plan)).digest("hex");
	const options: ManagedOptions = { kind: "client", stateDir: plan.stateDir, packageRoot: candidateRoot, host: plan.host, remoteCommand: plan.remoteCommand, expectedDeviceId: plan.deviceId, expectedPackageDigest: candidateDigest, expectedResumeDigest: approvalDigest, resumePluginData: data };
	await validateClientResumeLaunch(options);
	await loadClientIdentity(plan.stateDir, { expectedDeviceId: plan.deviceId });
	if ((await inspectSetupPackage(plan.packageRoot)).digest !== plan.packageDigest) throw new BridgeError("CLIENT_RESUME_PACKAGE_CONFLICT", "The approved package changed; migration was not authorized.");
	const owner = Owner.safeParse(await readOptionalJson(path.join(plan.stateDir, "client.managed.json")));
	const lock = Lock.safeParse(await readOptionalJson(path.join(plan.stateDir, "client.service.lock")));
	if (!owner.success || !lock.success || lock.data.pid !== owner.data.pid || owner.data.host !== plan.host || owner.data.runtime !== plan.runtime) throw new BridgeError("CLIENT_MIGRATION_OWNERSHIP", "Migration requires the original complete managed ownership and service lock matching the approved host/runtime.");
	if ((await inspectSetupPackage(owner.data.packageRoot)).digest !== owner.data.packageDigest) throw new BridgeError("CLIENT_RESUME_PACKAGE_CONFLICT", "The running client's package changed; migration was not authorized.");
	if (owner.data.packageRoot !== plan.packageRoot || owner.data.packageDigest !== plan.packageDigest) {
		await validateClientResumeLaunch({ ...options, packageRoot: owner.data.packageRoot, expectedPackageDigest: owner.data.packageDigest });
	}
	if (owner.data.packageDigest === candidateDigest) throw new BridgeError("CLIENT_MIGRATION_NOT_REQUIRED", "The recorded client already uses the candidate package; no legacy migration is required.");
	const health = await serviceHealth("client", plan.stateDir);
	if (health.deviceId !== plan.deviceId || health.endpoint.pid !== owner.data.pid) throw new BridgeError("SERVICE_IDENTITY_CONFLICT", "The authenticated client differs from the approved identity or managed process; no signal was sent.");
	const endpoint = health.endpoint;
	const lifecycle = await fetch(endpoint.url + "/v1/lifecycle", { headers: { authorization: `Bearer ${endpoint.token}` }, redirect: "error", signal: AbortSignal.timeout(3000) });
	await lifecycle.arrayBuffer();
	if (lifecycle.status !== 404) throw new BridgeError("CLIENT_MIGRATION_NOT_LEGACY", "The authenticated endpoint did not demonstrate the legacy 404 capability gap. Use normal maintenance; no signal was sent.");
	const evidence = await dependencies.inspectProcess(plan, owner.data, new URL(endpoint.url).port);
	assertLegacyProcessOwnership(plan, owner.data, evidence, await realpath(owner.data.runtime), data);
	await validateClientResumeLaunch(options);
	const snapshot = { plan, owner: owner.data, lock: lock.data, endpoint: { url: endpoint.url, tokenDigest: createHash("sha256").update(endpoint.token).digest("hex") }, evidence, candidateRoot, candidateDigest };
	return { kind: "legacy-client-migration" as const, confirmation: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"), pid: owner.data.pid, instance: owner.data.instance, deviceId: plan.deviceId, host: plan.host, packageRoot: owner.data.packageRoot, packageDigest: owner.data.packageDigest, candidateRoot, candidateDigest, processStartedAt: evidence.startedAt, warning: LEGACY_MIGRATION_WARNING };
}

/** Called under setup + launch locks, only after the explicit acknowledgement entrypoint. */
export async function stopLegacyClientForMigration(options: ManagedOptions, dependencies: LegacyMigrationSystem = system): Promise<void> {
	if (!options.resumePluginData || !options.legacyMigrationConfirmation || !Digest.safeParse(options.legacyMigrationConfirmation).success) throw new BridgeError("CLIENT_MIGRATION_CONFIRMATION_REQUIRED", "A fresh exact-process migration confirmation is required; no signal was sent.");
	const preview = await inspectLegacyClientMigration(options.resumePluginData, dependencies);
	if (preview.confirmation !== options.legacyMigrationConfirmation || preview.candidateRoot !== path.resolve(options.packageRoot) || preview.candidateDigest !== options.expectedPackageDigest || preview.deviceId !== options.expectedDeviceId) throw new BridgeError("CLIENT_MIGRATION_CONFIRMATION_STALE", "The process, approval, endpoint or package changed after inspection. Inspect again and obtain confirmation; no signal was sent.");
	// Re-read every input after potentially slow package and OS inspection, then recheck approval
	// at the point of risk. Never fall back to a PID file or send a second/stronger signal.
	const current = await inspectLegacyClientMigration(options.resumePluginData, dependencies);
	if (current.confirmation !== preview.confirmation) throw new BridgeError("CLIENT_MIGRATION_CONFIRMATION_STALE", "The client changed during migration admission; no signal was sent.");
	await validateClientResumeLaunch(options);
	dependencies.terminate(preview.pid);
	const deadline = dependencies.now() + 10000;
	while (dependencies.exists(preview.pid) && dependencies.now() < deadline) await dependencies.sleep(50);
	if (dependencies.exists(preview.pid)) throw new BridgeError("CLIENT_UPDATE_PENDING", "The verified legacy client has not finished graceful shutdown. No force kill or additional signal was sent; inspect the original service before retrying.");
}
