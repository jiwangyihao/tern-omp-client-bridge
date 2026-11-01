// SPDX-License-Identifier: MPL-2.0
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { loadClientIdentity, writePrivateJson } from "./config.ts";
import { BridgeError } from "./protocol.ts";
import { ensureManagedService, type ManagedOptions, type ManagedResult } from "./setup-managed.ts";
import { inspectSetupPackage } from "./setup-payload.ts";
import { validateHost } from "./setup-remote.ts";
import { acquireSetupLock, readOptionalJson } from "./setup-state.ts";

const AbsolutePathSchema = z.string().min(1).max(32768).refine(value => path.isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value) && path.resolve(value) === value);
export const ClientResumePlanSchema = z.object({
	schema: z.literal(1), kind: z.literal("client-resume"),
	host: z.string().min(1).max(255), remoteCommand: z.string().min(1).max(32768).refine(value => !/[\x00-\x1f\x7f]/.test(value)),
	stateDir: AbsolutePathSchema, controlFile: AbsolutePathSchema, packageRoot: AbsolutePathSchema, runtime: AbsolutePathSchema,
	deviceId: z.string().regex(/^client_[a-f0-9]{32}$/), packageDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().refine(plan => plan.controlFile === path.join(plan.stateDir, "client.json"));
export type ClientResumePlan = z.infer<typeof ClientResumePlanSchema>;
export type ClientResumeResult = Omit<ManagedResult, "kind"> & { kind: "client-resumed" };

async function matchingConfig(data: string, controlFile: string): Promise<void> {
	const config = z.object({ controlFile: AbsolutePathSchema }).safeParse(await readOptionalJson(path.join(data, "config.json")));
	if (!config.success || config.data.controlFile !== controlFile) throw new BridgeError("CLIENT_RESUME_CONFIG_CONFLICT", "The installed plugin configuration no longer matches the approved client. Run explicit setup to review the connection.");
}

/** Only consented setup calls this, after remote signed registration and config merge. */
export async function saveClientResumePlan(pluginData: string, input: ClientResumePlan): Promise<void> {
	const plan = ClientResumePlanSchema.parse(input);
	validateHost(plan.host);
	await matchingConfig(pluginData, plan.controlFile);
	await loadClientIdentity(plan.stateDir, { expectedDeviceId: plan.deviceId });
	await writePrivateJson(path.join(pluginData, "client-resume.json"), plan);
}

/** Re-read revocable approval at the launcher and detached-child admission boundaries. */
export async function validateClientResumeLaunch(options: ManagedOptions): Promise<void> {
	if (options.resumePluginData === undefined) return;
	const data = AbsolutePathSchema.safeParse(options.resumePluginData);
	if (!data.success || options.kind !== "client") throw new BridgeError("CLIENT_RESUME_INVALID", "Recovery requires the approved local client configuration.");
	const raw = await readOptionalJson(path.join(data.data, "client-resume.json"));
	if (raw === undefined) throw new BridgeError("CLIENT_RESUME_SETUP_REQUIRED", "The local recovery approval was removed. Run explicit setup to authorize recovery again.");
	const parsed = ClientResumePlanSchema.safeParse(raw);
	if (!parsed.success) throw new BridgeError("CLIENT_RESUME_INVALID", "The saved local recovery plan is invalid. Run explicit setup to review it.");
	const plan = parsed.data;
	validateHost(plan.host);
	if (plan.host !== options.host || plan.remoteCommand !== options.remoteCommand || plan.stateDir !== path.resolve(options.stateDir) || plan.controlFile !== path.join(path.resolve(options.stateDir), "client.json") || plan.packageRoot !== path.resolve(options.packageRoot) || plan.packageRoot !== path.resolve(fileURLToPath(new URL("../", import.meta.url))) || plan.runtime !== process.execPath || plan.deviceId !== options.expectedDeviceId || plan.packageDigest !== options.expectedPackageDigest) throw new BridgeError("CLIENT_RESUME_CONFLICT", "The local recovery approval changed before startup. No client was started; run explicit setup to review the connection.");
	await matchingConfig(data.data, plan.controlFile);
}

/** Resume only the approved local service. No provisioning, remote lifecycle or binding changes. */
export async function resumeClient(pluginData: string): Promise<ClientResumeResult> {
	const data = path.resolve(pluginData);
	const raw = await readOptionalJson(path.join(data, "client-resume.json"));
	if (raw === undefined) throw new BridgeError("CLIENT_RESUME_SETUP_REQUIRED", "This installation has no approved local recovery plan. Run Set up Bridge once to enable recovery.");
	const parsed = ClientResumePlanSchema.safeParse(raw);
	if (!parsed.success) throw new BridgeError("CLIENT_RESUME_INVALID", "The saved local recovery plan is invalid. Run explicit setup to review it.");
	const plan = parsed.data;
	validateHost(plan.host);
	const release = await acquireSetupLock(path.join(data, "setup.lock"));
	try {
		// Setup and recovery share the lock; do not act on an approval replaced while acquiring it.
		if (JSON.stringify(await readOptionalJson(path.join(data, "client-resume.json"))) !== JSON.stringify(raw)) throw new BridgeError("CLIENT_RESUME_CONFLICT", "The local recovery approval changed. Retry after setup finishes.");
		await matchingConfig(data, plan.controlFile);
		if (plan.runtime !== process.execPath || plan.packageRoot !== path.resolve(fileURLToPath(new URL("../", import.meta.url)))) throw new BridgeError("CLIENT_RESUME_PACKAGE_CONFLICT", "Recovery must use the exact runtime and package approved by setup. Run explicit setup to review the installation.");
		const { digest } = await inspectSetupPackage(plan.packageRoot);
		if (digest !== plan.packageDigest) throw new BridgeError("CLIENT_RESUME_PACKAGE_CONFLICT", "The approved bridge package has changed. Run explicit setup before restarting the local client.");
		await loadClientIdentity(plan.stateDir, { expectedDeviceId: plan.deviceId });
		const result = await ensureManagedService({ kind: "client", stateDir: plan.stateDir, packageRoot: plan.packageRoot, host: plan.host, remoteCommand: plan.remoteCommand, expectedDeviceId: plan.deviceId, expectedPackageDigest: plan.packageDigest, resumePluginData: data });
		return { ...result, kind: "client-resumed" };
	} finally { await release(); }
}
