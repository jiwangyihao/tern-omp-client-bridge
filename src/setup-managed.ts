// SPDX-License-Identifier: MPL-2.0
import { spawn, type ChildProcess } from "node:child_process";
import { register as registerExitCleanup } from "@oh-my-pi/pi-utils/postmortem";
import { open, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { startBroker } from "./broker.ts";
import { startClientService } from "./client.ts";
import { loadClientIdentity, readEndpoint, writePrivateJson, type ClientIdentity, type Endpoint } from "./config.ts";
import { BridgeError, PROTOCOL_VERSION } from "./protocol.ts";
import { LocalUiStateSchema } from "./schemas.ts";
import { acquireSetupLock, privateDirectory, processExists, readOptionalJson } from "./setup-state.ts";
import { inspectSetupPackage } from "./setup-payload.ts";
import { validateClientResumeLaunch } from "./client-resume.ts";

const KindSchema = z.enum(["server", "client"]);
const RecordSchema = z.object({
	schema: z.literal(1), kind: KindSchema, pid: z.number().int().positive(), instance: z.string().uuid(),
	ownership: z.enum(["managed", "existing"]), host: z.string().optional(), startedAt: z.number().optional(), observedAt: z.number().optional(),
	packageRoot: z.string().optional(), runtime: z.string().optional(), packageDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
const ClientLifecycleSchema = z.object({ schema: z.literal(1), kind: z.literal("client-lifecycle"), pid: z.number().int().positive(), instance: z.string().uuid(), packageDigest: z.string().regex(/^[a-f0-9]{64}$/), deviceId: z.string(), busy: z.boolean(), draining: z.boolean() });
export const ManagedResultSchema = z.object({
	kind: KindSchema, stateDir: z.string(), controlFile: z.string(), pid: z.number().int().positive(),
	reused: z.boolean(), ownership: z.enum(["managed", "existing"]), connected: z.boolean(),
	deviceId: z.string().optional(), sessionReady: z.boolean(),
	packageRoot: z.string().optional(), runtime: z.string().optional(), packageDigest: z.string().optional(), upgradeRequired: z.boolean(),
});
export type ManagedResult = z.infer<typeof ManagedResultSchema>;
export interface ManagedOptions {
	kind: "server" | "client";
	stateDir: string;
	packageRoot: string;
	host?: string;
	remoteCommand?: string;
	/** Recovery never provisions or rotates identity, including in the detached child. */
	expectedDeviceId?: string;
	expectedPackageDigest?: string;
	/** Admission snapshot of the revocable connection grant, independent of package upgrades. */
	expectedResumeDigest?: string;
	/** Only resume supplies this; ordinary consented setup does not require a receipt. */
	resumePluginData?: string;
	/** Recovery preserves any live client; update may switch an authenticated idle client. */
	clientMaintenance?: "recover" | "update";
}
export interface ServiceHealth { endpoint: Endpoint; connected: boolean; deviceId?: string; sessionReady: boolean }

export async function setupIdentity(stateDir: string): Promise<ClientIdentity> {
	return loadClientIdentity(stateDir);
}
/** Authenticated loopback only. Redirects cannot disclose the bearer to another endpoint. */
export async function serviceHealth(kind: "server" | "client", stateDir: string): Promise<ServiceHealth> {
	const endpoint = await readEndpoint(path.join(stateDir, `${kind}.json`));
	if (!endpoint.pid || !processExists(endpoint.pid)) throw new BridgeError("SERVICE_OFFLINE", "The recorded bridge service is not running.");
	const response = await fetch(endpoint.url + (kind === "server" ? "/v1/health" : "/v1/state"), {
		headers: { authorization: `Bearer ${endpoint.token}` }, redirect: "error", signal: AbortSignal.timeout(2000),
	});
	if (!response.ok) throw new BridgeError("SERVICE_UNAUTHENTICATED", "The bridge service did not accept its private control credential.");
	const text = await response.text();
	if (text.length > 1024 * 1024) throw new BridgeError("SERVICE_UNAUTHENTICATED", "The bridge returned an oversized readiness response.");
	if (kind === "server") {
		z.object({ ok: z.literal(true), protocol: z.literal(PROTOCOL_VERSION) }).parse(JSON.parse(text));
		return { endpoint, connected: true, sessionReady: false };
	}
	const state = LocalUiStateSchema.parse(JSON.parse(text));
	// connected becomes true only after the client's existing signed-registration path completes.
	return { endpoint, connected: state.connected, deviceId: state.device.id, sessionReady: state.connected && Object.values(state.views).some(view => !!view.sessionId && !!view.resolveIntentId) };
}

async function clearDeadBrokerLock(stateDir: string): Promise<void> {
	const file = path.join(stateDir, "server.lock");
	const saved = await readOptionalJson(file);
	if (saved === undefined) return;
	const lock = z.object({ pid: z.number().int().positive(), instance: z.string() }).safeParse(saved);
	if (!lock.success || processExists(lock.data.pid)) throw new BridgeError("SERVICE_BUSY", "An existing broker owns this state directory but is not healthy. Inspect its original service or terminal; setup will not stop it.");
	const current = await readOptionalJson(file);
	if (JSON.stringify(current) === JSON.stringify(saved)) await rm(file);
}

async function requestClientUpdate(record: z.infer<typeof RecordSchema>, health: ServiceHealth, deviceId: string): Promise<boolean> {
	if (record.kind !== "client" || record.ownership !== "managed" || record.pid !== health.endpoint.pid || !record.host || !record.packageRoot || !record.runtime || !record.packageDigest) return false;
	const headers = { authorization: `Bearer ${health.endpoint.token}` };
	const response = await fetch(health.endpoint.url + "/v1/lifecycle", { headers, redirect: "error", signal: AbortSignal.timeout(3000) });
	if (response.status === 404) { await response.arrayBuffer(); return false; }
	if (!response.ok) throw new BridgeError("SERVICE_CONFLICT", "The current client did not authenticate its lifecycle; it was not stopped.");
	const text = await response.text();
	if (text.length > 16384) throw new BridgeError("SERVICE_CONFLICT", "The current client returned invalid lifecycle metadata.");
	const parsed = ClientLifecycleSchema.safeParse(JSON.parse(text));
	if (!parsed.success || parsed.data.pid !== record.pid || parsed.data.instance !== record.instance || parsed.data.packageDigest !== record.packageDigest || parsed.data.deviceId !== deviceId) throw new BridgeError("SERVICE_CONFLICT", "The authenticated client does not match its managed ownership record; it was not stopped.");
	if (parsed.data.busy || parsed.data.draining) return false;
	const stopped = await fetch(health.endpoint.url + "/v1/lifecycle/shutdown", {
		method: "POST", headers: { ...headers, "content-type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(5000),
		body: JSON.stringify({ instance: record.instance, packageDigest: record.packageDigest }),
	});
	const acknowledgement: unknown = await stopped.json();
	if (stopped.status === 409 && z.object({ code: z.literal("CLIENT_UPDATE_BUSY") }).safeParse(acknowledgement).success) return false;
	const accepted = z.object({ accepted: z.literal(true), instance: z.literal(record.instance) }).safeParse(acknowledgement);
	if (!stopped.ok || !accepted.success) throw new BridgeError("SERVICE_CONFLICT", "The managed client did not accept the idle update request; no process signal was sent.");
	const deadline = Date.now() + 10000;
	while (processExists(record.pid) && Date.now() < deadline) await Bun.sleep(50);
	if (processExists(record.pid)) throw new BridgeError("CLIENT_UPDATE_PENDING", "The owned client is still finishing its graceful shutdown; automatic maintenance will retry without forcing it.");
	return true;
}

/** Finite launcher; the child owns listeners, identity and signal cleanup, never this SSH/stdin pipe. */
export async function ensureManagedService(options: ManagedOptions): Promise<ManagedResult> {
	if (options.clientMaintenance && options.kind !== "client") throw new BridgeError("USAGE", "Automatic maintenance cannot replace a broker.");
	const stateDir = path.resolve(options.stateDir);
	await privateDirectory(stateDir);
	const release = await acquireSetupLock(path.join(stateDir, `${options.kind}.launch.lock`));
	try {
		if (options.resumePluginData !== undefined) await validateClientResumeLaunch(options);
		const requestedDigest = (await inspectSetupPackage(options.packageRoot)).digest;
		if (options.expectedPackageDigest !== undefined && requestedDigest !== options.expectedPackageDigest) throw new BridgeError("CLIENT_RESUME_PACKAGE_CONFLICT", "The approved bridge package changed before launch. Run explicit setup to review it.");
		const recordFile = path.join(stateDir, `${options.kind}.managed.json`);
		const rawRecord = await readOptionalJson(recordFile);
		let record = rawRecord === undefined ? undefined : RecordSchema.parse(rawRecord);
		if (record && record.kind !== options.kind) throw new BridgeError("SERVICE_CONFLICT", "Managed service metadata has a different service kind.");
		if (record?.host && options.host && record.host !== options.host && processExists(record.pid)) throw new BridgeError("SERVICE_HOST_CONFLICT", "This client is already owned by a different SSH host. Use its original configuration or a separate plugin data directory; setup will not retarget a live client.");
		const identity = options.kind === "client" ? await loadClientIdentity(stateDir, { expectedDeviceId: options.expectedDeviceId }) : undefined;
		let health: ServiceHealth | undefined;
		try { health = await serviceHealth(options.kind, stateDir); } catch { /* Inspect process ownership before considering a restart. */ }
		if (health && identity && health.deviceId !== identity.device.id) throw new BridgeError("SERVICE_IDENTITY_CONFLICT", "The running client does not match the saved identity. Setup will not overwrite its connection metadata.");
		if (options.clientMaintenance === "update" && identity && health && record?.ownership === "managed" && record.pid === health.endpoint.pid && record.packageDigest !== requestedDigest) {
			if (await requestClientUpdate(record, health, identity.device.id)) { health = undefined; record = undefined; }
		}
		let reused = true;
		let launched: ChildProcess | undefined;
		if (!health) {
			let endpoint: Endpoint | undefined;
			try { endpoint = await readEndpoint(path.join(stateDir, `${options.kind}.json`)); } catch { /* A half-installed service may have no endpoint yet. */ }
			if ((record && processExists(record.pid)) || (endpoint?.pid && processExists(endpoint.pid))) throw new BridgeError("SERVICE_BUSY", "The recorded bridge process is alive but failed authenticated readiness. Inspect its private service log or original terminal; no process was stopped.");
			if (options.kind === "server") await clearDeadBrokerLock(stateDir);
			if (record) { await rm(recordFile); record = undefined; }
			const cli = path.join(path.resolve(options.packageRoot), "src", "cli.ts");
			const args = [cli, "managed-service", "--kind", options.kind, "--state-dir", stateDir, "--package-root", path.resolve(options.packageRoot)];
			if (options.kind === "client") {
				if (!options.host || !options.remoteCommand) throw new BridgeError("USAGE", "A managed client requires an SSH host and a remote relay command.");
				args.push("--host", options.host, "--remote-command", options.remoteCommand);
				args.push("--expected-device-id", identity!.device.id);
				if (options.expectedPackageDigest !== undefined) args.push("--expected-package-digest", options.expectedPackageDigest);
				if (options.expectedResumeDigest !== undefined) args.push("--expected-resume-digest", options.expectedResumeDigest);
				if (options.resumePluginData !== undefined) args.push("--resume-plugin-data", options.resumePluginData);
			}
			const log = await open(path.join(stateDir, `${options.kind}.service.log`), "w", 0o600);
			try {
				const child = spawn(process.execPath, args, { cwd: options.packageRoot, detached: true, stdio: ["ignore", log.fd, log.fd], windowsHide: true });
				launched = child;
				await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
				child.unref();
			} finally { await log.close(); }
			reused = false;
		}
		const deadline = Date.now() + 35000;
		while (!health || (!health.connected && !options.clientMaintenance)) {
			if (launched && (launched.exitCode !== null || launched.signalCode !== null)) throw new BridgeError("SERVICE_START_FAILED", "The owned client process exited before becoming available; inspect its private service log.");
			if (Date.now() >= deadline) throw new BridgeError("SERVICE_NOT_READY", options.kind === "client" ? "The client did not complete signed SSH registration. Check trusted SSH access and the private client service log, then retry." : "The background broker did not become healthy. Check the private server service log and retry.");
			await Bun.sleep(150);
			try { health = await serviceHealth(options.kind, stateDir); } catch { health = undefined; }
		}
		if (identity && health.deviceId !== identity.device.id) throw new BridgeError("SERVICE_IDENTITY_CONFLICT", "Authenticated readiness returned a different client identity.");
		let saved = await readOptionalJson(recordFile);
		if (!reused) {
			const published = Date.now() + 2000;
			while (saved === undefined && Date.now() < published) { await Bun.sleep(50); saved = await readOptionalJson(recordFile); }
			if (saved === undefined) throw new BridgeError("SERVICE_NOT_READY", "The detached service did not publish its ownership record. Inspect its private log before retrying.");
		}
		record = saved === undefined ? undefined : RecordSchema.parse(saved);
		if (record && record.pid !== health.endpoint.pid) {
			if (processExists(record.pid)) throw new BridgeError("SERVICE_CONFLICT", "The managed record and authenticated endpoint identify different live processes; neither was replaced.");
			// A manual restart can leave an observational record behind. Do not attribute the
			// retired process's source, runtime, host or ownership to the authenticated replacement.
			record = undefined;
		}
		if (!record) {
			record = { schema: 1, kind: options.kind, pid: health.endpoint.pid!, instance: crypto.randomUUID(), ownership: "existing", observedAt: Date.now() };
			await writePrivateJson(recordFile, record);
		}
		const upgradeRequired = (options.clientMaintenance !== undefined || record.ownership === "managed") && record.packageDigest !== requestedDigest;
		return { kind: options.kind, stateDir, controlFile: path.join(stateDir, `${options.kind}.json`), pid: record.pid, reused, ownership: record.ownership, connected: health.connected, ...(health.deviceId ? { deviceId: health.deviceId } : {}), sessionReady: health.sessionReady, packageRoot: record.packageRoot, runtime: record.runtime, packageDigest: record.packageDigest, upgradeRequired };
	} finally { await release(); }
}

/** Internal detached lifecycle. Foreground server/client continue to stop on stdin EOF. */
export async function runManagedService(options: ManagedOptions): Promise<void> {
	const stateDir = path.resolve(options.stateDir);
	const release = await acquireSetupLock(path.join(stateDir, `${options.kind}.service.lock`));
	const recordFile = path.join(stateDir, `${options.kind}.managed.json`);
	const instance = crypto.randomUUID();
	const stopped = Promise.withResolvers<void>();
	const finished = Promise.withResolvers<void>();
	// The imported native SDK owns signal exits and hard-exits after its cleanup registry.
	// Join that registry so it cannot exit(143) ahead of bridge listener/metadata cleanup.
	const unregister = registerExitCleanup(`tern-omp-bridge-managed-${options.kind}`, () => {
		stopped.resolve();
		return finished.promise;
	}, { exitOnly: true });
	let service: { endpoint: Endpoint; close(): Promise<void> } | undefined;
	try {
		if (options.resumePluginData !== undefined) await validateClientResumeLaunch(options, true);
		const { digest } = await inspectSetupPackage(options.packageRoot);
		if (options.expectedPackageDigest !== undefined && digest !== options.expectedPackageDigest) throw new BridgeError("CLIENT_RESUME_PACKAGE_CONFLICT", "The approved bridge package changed before the child started. Run explicit setup to review it.");
		let existing: Endpoint | undefined;
		try { existing = await readEndpoint(path.join(stateDir, `${options.kind}.json`)); } catch { /* Missing metadata is expected on first installation. */ }
		if (existing?.pid && processExists(existing.pid)) throw new BridgeError("SERVICE_BUSY", "Another live service already owns this endpoint. Use managed-start to authenticate and reuse it.");
		if (options.kind === "server") service = await startBroker({ stateDir });
		else {
			if (!options.host || !options.remoteCommand) throw new BridgeError("USAGE", "A managed client requires an SSH host and a remote relay command.");
			const identity = await loadClientIdentity(stateDir, { expectedDeviceId: options.expectedDeviceId });
			// Recheck revocation after package/identity IO, immediately before creating the client.
			if (options.resumePluginData !== undefined) await validateClientResumeLaunch(options, true);
			service = await startClientService({ stateDir, identity, serverName: options.host, connection: { kind: "ssh", host: options.host, remoteCommand: options.remoteCommand }, lifecycle: { instance, packageDigest: digest, onShutdown: () => stopped.resolve() } });
		}
		await writePrivateJson(recordFile, { schema: 1, kind: options.kind, pid: process.pid, instance, ownership: "managed", startedAt: Date.now(), packageRoot: path.resolve(options.packageRoot), packageDigest: digest, runtime: process.execPath, ...(options.host ? { host: options.host } : {}) });
		await stopped.promise;
	} finally {
		try {
			try { await service?.close(); }
			finally {
				try {
					const record = RecordSchema.safeParse(await readOptionalJson(recordFile));
					if (record.success && record.data.instance === instance) await rm(recordFile, { force: true });
				} finally { await release(); }
			}
		} finally { unregister(); finished.resolve(); }
	}
}
