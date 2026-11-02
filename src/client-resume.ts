// SPDX-License-Identifier: MPL-2.0
import { createHash } from "node:crypto";
import { lstat, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { loadClientIdentity, writePrivateJson } from "./config.ts";
import { BridgeError } from "./protocol.ts";
import { ensureManagedService, serviceHealth, type ManagedOptions, type ManagedResult } from "./setup-managed.ts";
import { inspectSetupPackage } from "./setup-payload.ts";
import { validateHost } from "./setup-remote.ts";
import { acquireSetupLock, processExists, readOptionalJson } from "./setup-state.ts";
import { recoverLegacyClientPlan } from "./client-legacy.ts";

const AbsolutePathSchema = z.string().min(1).max(32768).refine(value => path.isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value) && path.resolve(value) === value);
export const ClientResumePlanSchema = z.object({
	schema: z.literal(1), kind: z.literal("client-resume"),
	host: z.string().min(1).max(255), remoteCommand: z.string().min(1).max(32768).refine(value => !/[\x00-\x1f\x7f]/.test(value)),
	stateDir: AbsolutePathSchema, controlFile: AbsolutePathSchema, packageRoot: AbsolutePathSchema, runtime: AbsolutePathSchema,
	deviceId: z.string().regex(/^client_[a-f0-9]{32}$/), packageDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().refine(plan => plan.controlFile === path.join(plan.stateDir, "client.json"));
export type ClientResumePlan = z.infer<typeof ClientResumePlanSchema>;
export type ClientResumeResult = Omit<ManagedResult, "kind"> & { kind: "client-resumed"; updateDeferred?: "busy" | "rollback"; retryAfterMs?: number };
const OwnedClientSnapshot = z.object({ schema: z.literal(1), kind: z.literal("client"), ownership: z.literal("managed"), pid: z.number().int().positive(), instance: z.string().uuid(), host: z.string(), packageRoot: AbsolutePathSchema, runtime: AbsolutePathSchema, packageDigest: z.string().regex(/^[a-f0-9]{64}$/) });
const UpdateFallback = z.object({ schema: z.literal(1), requestedDigest: z.string().regex(/^[a-f0-9]{64}$/), packageRoot: AbsolutePathSchema, packageDigest: z.string().regex(/^[a-f0-9]{64}$/), retryAfter: z.number().finite().nonnegative() }).strict();

async function rememberRecoveryInitialization(data: string): Promise<void> {
	const file = path.join(data, "client-resume-initialized.json");
	const previous = await readOptionalJson(file);
	if (previous === undefined) await writePrivateJson(file, { schema: 1 });
	else if (!z.object({ schema: z.literal(1) }).strict().safeParse(previous).success) throw new BridgeError("CLIENT_RESUME_INVALID", "The recovery initialization record is invalid; automatic maintenance will not replace it.");
}

async function matchingConfig(data: string, controlFile: string): Promise<void> {
	const config = z.object({ controlFile: AbsolutePathSchema }).safeParse(await readOptionalJson(path.join(data, "config.json")));
	if (!config.success || config.data.controlFile !== controlFile) throw new BridgeError("CLIENT_RESUME_CONFIG_CONFLICT", "The installed plugin configuration no longer matches the approved client. Run explicit setup to review the connection.");
}

async function assertPreparedClientPackage(data: string, packageRoot: string, packageDigest: string): Promise<void> {
	const marker = z.object({ schema: z.literal(1), source: z.string(), runtime: z.string() }).safeParse(await readOptionalJson(path.join(packageRoot, ".bridge-installation.json")));
	const [info, dataInfo, actualRoot, actualData] = await Promise.all([lstat(packageRoot), lstat(data), realpath(packageRoot), realpath(data)]);
	// Native parent aliases (/var on macOS, Windows short names/junctions) do not change ownership.
	// Resolve only the data root before constructing the expected cache path: redirected cache children still fail.
	const expectedRoot = path.join(actualData, "installation", "packages", packageDigest);
	if (!dataInfo.isDirectory() || dataInfo.isSymbolicLink() || path.relative(expectedRoot, actualRoot) !== "" || !info.isDirectory() || info.isSymbolicLink() || !marker.success || marker.data.source !== packageDigest || marker.data.runtime !== `${process.platform}-${process.arch}`) throw new BridgeError("CLIENT_RESUME_PACKAGE_CONFLICT", "The replacement client is not a verified private installation package.");
}

/** Explicit setup and verified legacy migration establish revocable local recovery. */
export async function saveClientResumePlan(pluginData: string, input: ClientResumePlan): Promise<void> {
	const plan = ClientResumePlanSchema.parse(input);
	validateHost(plan.host);
	await matchingConfig(pluginData, plan.controlFile);
	await loadClientIdentity(plan.stateDir, { expectedDeviceId: plan.deviceId });
	await rememberRecoveryInitialization(path.resolve(pluginData));
	await writePrivateJson(path.join(pluginData, "client-resume.json"), plan);
}

/** Re-read revocable approval at the launcher and detached-child admission boundaries. */
export async function validateClientResumeLaunch(options: ManagedOptions, executing = false): Promise<void> {
	if (options.resumePluginData === undefined) return;
	const data = AbsolutePathSchema.safeParse(options.resumePluginData);
	if (!data.success || options.kind !== "client") throw new BridgeError("CLIENT_RESUME_INVALID", "Recovery requires the approved local client configuration.");
	const raw = await readOptionalJson(path.join(data.data, "client-resume.json"));
	if (raw === undefined) throw new BridgeError("CLIENT_RESUME_SETUP_REQUIRED", "The local recovery approval was removed. Run explicit setup to authorize recovery again.");
	const parsed = ClientResumePlanSchema.safeParse(raw);
	if (!parsed.success) throw new BridgeError("CLIENT_RESUME_INVALID", "The saved local recovery plan is invalid. Run explicit setup to review it.");
	const plan = parsed.data;
	validateHost(plan.host);
	if (plan.host !== options.host || plan.remoteCommand !== options.remoteCommand || plan.stateDir !== path.resolve(options.stateDir) || plan.controlFile !== path.join(path.resolve(options.stateDir), "client.json") || plan.runtime !== process.execPath || plan.deviceId !== options.expectedDeviceId) throw new BridgeError("CLIENT_RESUME_CONFLICT", "The local recovery approval changed before startup. No client was started.");
	const target = path.resolve(options.packageRoot);
	if (options.expectedResumeDigest !== undefined) {
		if (createHash("sha256").update(JSON.stringify(plan)).digest("hex") !== options.expectedResumeDigest) throw new BridgeError("CLIENT_RESUME_CONFLICT", "The recovery authorization changed after maintenance admission.");
		if (target !== plan.packageRoot || options.expectedPackageDigest !== plan.packageDigest) {
			if (options.expectedPackageDigest === undefined) throw new BridgeError("CLIENT_RESUME_CONFLICT", "The maintained package has no verified digest.");
			await assertPreparedClientPackage(data.data, target, options.expectedPackageDigest);
		}
	} else if (target !== plan.packageRoot || options.expectedPackageDigest !== plan.packageDigest) throw new BridgeError("CLIENT_RESUME_CONFLICT", "The approved client package changed before startup.");
	if (executing && target !== path.resolve(fileURLToPath(new URL("../", import.meta.url)))) throw new BridgeError("CLIENT_RESUME_CONFLICT", "The detached client is not executing the admitted package.");
	await matchingConfig(data.data, plan.controlFile);
}

/** Maintain the existing client with the installed, verified private package; never alter its broker. */
export async function resumeClient(pluginData: string): Promise<ClientResumeResult> {
	const data = path.resolve(pluginData);
	const raw = await readOptionalJson(path.join(data, "client-resume.json"));
	if (raw !== undefined && !ClientResumePlanSchema.safeParse(raw).success) throw new BridgeError("CLIENT_RESUME_INVALID", "The saved local recovery plan is invalid. Automatic maintenance will not replace it.");
	const release = await acquireSetupLock(path.join(data, "setup.lock"));
	try {
		if (JSON.stringify(await readOptionalJson(path.join(data, "client-resume.json"))) !== JSON.stringify(raw)) throw new BridgeError("CLIENT_RESUME_CONFLICT", "The local recovery approval changed while acquiring maintenance ownership.");
		const plan = raw === undefined ? await recoverLegacyClientPlan(data) : ClientResumePlanSchema.parse(raw);
		validateHost(plan.host);
		await matchingConfig(data, plan.controlFile);
		if (plan.runtime !== process.execPath) throw new BridgeError("CLIENT_RESUME_PACKAGE_CONFLICT", "Automatic recovery must use the existing approved runtime executable.");
		const approved = await inspectSetupPackage(plan.packageRoot);
		if (approved.digest !== plan.packageDigest) throw new BridgeError("CLIENT_RESUME_PACKAGE_CONFLICT", "The approved client package changed unexpectedly; automatic maintenance will not execute or replace it.");
		await loadClientIdentity(plan.stateDir, { expectedDeviceId: plan.deviceId });
		const packageRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
		let packageDigest = approved.digest;
		if (packageRoot !== plan.packageRoot) {
			packageDigest = (await inspectSetupPackage(packageRoot)).digest;
			await assertPreparedClientPackage(data, packageRoot, packageDigest);
		}
		const desired = ClientResumePlanSchema.parse({ ...plan, packageRoot, packageDigest, runtime: process.execPath });
		if (JSON.stringify(await readOptionalJson(path.join(data, "client-resume.json"))) !== JSON.stringify(raw)) throw new BridgeError("CLIENT_RESUME_CONFLICT", "Recovery authorization changed during package verification; no client was started.");
		if (raw === undefined) await saveClientResumePlan(data, plan);
		else await rememberRecoveryInitialization(data);
		const expectedResumeDigest = createHash("sha256").update(JSON.stringify(plan)).digest("hex");
		const maintain = (root: string, digest: string, mode: "recover" | "update") => ensureManagedService({ kind: "client", stateDir: plan.stateDir, packageRoot: root, host: plan.host, remoteCommand: plan.remoteCommand, expectedDeviceId: plan.deviceId, expectedPackageDigest: digest, expectedResumeDigest: root === plan.packageRoot && digest === plan.packageDigest ? undefined : expectedResumeDigest, resumePluginData: data, clientMaintenance: mode });
		const fallbackFile = path.join(data, "client-update-failure.json");
		const previous = OwnedClientSnapshot.safeParse(await readOptionalJson(path.join(plan.stateDir, "client.managed.json")));
		const health = await serviceHealth("client", plan.stateDir).catch(() => undefined);
		if (health && health.deviceId !== plan.deviceId) throw new BridgeError("SERVICE_IDENTITY_CONFLICT", "The running client does not match the existing recovery identity.");
		const previousClient = previous.success && health?.endpoint.pid === previous.data.pid && previous.data.host === plan.host && previous.data.runtime === plan.runtime ? previous.data : undefined;
		async function verifyFallback(root: string, digest: string): Promise<void> {
			if (root !== plan.packageRoot || digest !== plan.packageDigest) await assertPreparedClientPackage(data, root, digest);
			if ((await inspectSetupPackage(root)).digest !== digest) throw new BridgeError("CLIENT_RESUME_PACKAGE_CONFLICT", "The previous client package changed; it cannot be used for rollback.");
		}
		const failureRaw = await readOptionalJson(fallbackFile);
		const failure = UpdateFallback.safeParse(failureRaw);
		if (failureRaw !== undefined && !failure.success) throw new BridgeError("CLIENT_RESUME_CONFLICT", "The client update recovery record is invalid.");
		const now = Date.now();
		if (failure.success && failure.data.requestedDigest === desired.packageDigest && failure.data.retryAfter > now && failure.data.retryAfter - now <= 60000 && (!health || (previousClient?.packageRoot === failure.data.packageRoot && previousClient.packageDigest === failure.data.packageDigest))) {
			await verifyFallback(failure.data.packageRoot, failure.data.packageDigest);
			const retained = await maintain(failure.data.packageRoot, failure.data.packageDigest, "recover");
			if (retained.packageDigest !== desired.packageDigest) return { ...retained, kind: "client-resumed", upgradeRequired: true, updateDeferred: "rollback", retryAfterMs: Math.max(1000, failure.data.retryAfter - Date.now()) };
			await rm(fallbackFile, { force: true });
			return { ...retained, kind: "client-resumed", upgradeRequired: false };
		}
		const rollback = previousClient && previousClient.packageDigest !== desired.packageDigest ? previousClient : undefined;
		if (rollback) await verifyFallback(rollback.packageRoot, rollback.packageDigest);
		try {
			const result = await maintain(desired.packageRoot, desired.packageDigest, "update");
			if (!result.upgradeRequired) await rm(fallbackFile, { force: true });
			return { ...result, kind: "client-resumed", ...(result.upgradeRequired ? { updateDeferred: "busy" as const, retryAfterMs: 10000 } : {}) };
		} catch (error) {
			if (!rollback || processExists(rollback.pid)) throw error;
			const approval = ClientResumePlanSchema.safeParse(await readOptionalJson(path.join(data, "client-resume.json")));
			if (!approval.success || createHash("sha256").update(JSON.stringify(approval.data)).digest("hex") !== expectedResumeDigest) throw new BridgeError("CLIENT_RESUME_CONFLICT", "Recovery approval changed; rollback was not authorized.");
			for (const file of [path.join(plan.stateDir, "client.managed.json"), plan.controlFile]) {
				const value = await readOptionalJson(file);
				const owner = z.object({ pid: z.number().int().positive() }).safeParse(value);
				if (value !== undefined && (!owner.success || processExists(owner.data.pid))) throw error;
			}
			await verifyFallback(rollback.packageRoot, rollback.packageDigest);
			const restored = await maintain(rollback.packageRoot, rollback.packageDigest, "recover");
			if (restored.packageDigest === desired.packageDigest) return { ...restored, kind: "client-resumed", upgradeRequired: false };
			await writePrivateJson(fallbackFile, { schema: 1, requestedDigest: desired.packageDigest, packageRoot: rollback.packageRoot, packageDigest: rollback.packageDigest, retryAfter: Date.now() + 60000 });
			return { ...restored, kind: "client-resumed", upgradeRequired: true, updateDeferred: "rollback", retryAfterMs: 60000 };
		}
	} finally { await release(); }
}
