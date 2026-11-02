// SPDX-License-Identifier: MPL-2.0
import path from "node:path";
import { z } from "zod";
import { ClientResumePlanSchema, saveClientResumePlan, type ClientResumePlan } from "./client-resume.ts";
import { readEndpoint } from "./config.ts";
import { BridgeError } from "./protocol.ts";
import { serviceHealth, type ServiceHealth } from "./setup-managed.ts";
import { remotePath, setupCommand, sshCommand } from "./setup-remote.ts";
import { processExists, readOptionalJson } from "./setup-state.ts";

const BrokerIdentitySchema = z.object({ instance: z.string().uuid(), credentialDigest: z.string().regex(/^[a-f0-9]{64}$/), deviceId: z.string(), registered: z.literal(true) });
export type BrokerIdentity = z.infer<typeof BrokerIdentitySchema>;

/** Self-contained so the same read-only probe runs using an already-installed remote runtime. */
export async function readBrokerIdentity(stateDir: string, deviceId: string, packageRoot: string): Promise<BrokerIdentity> {
	const { readEndpoint } = await import(`${packageRoot}/src/config.ts`);
	const { ServerStateSchema } = await import(`${packageRoot}/src/schemas.ts`);
	// This function is serialized across the installed-runtime boundary; static imports cannot travel with it.
	const { readFile } = await import("node:fs/promises");
	const { createHash } = await import("node:crypto");
	const endpoint = await readEndpoint(`${stateDir}/server.json`);
	const lock = JSON.parse(await readFile(`${stateDir}/server.lock`, "utf8"));
	if (!endpoint.pid || lock.pid !== endpoint.pid || typeof lock.instance !== "string") throw Error("Broker ownership changed");
	process.kill(endpoint.pid, 0);
	const response = await fetch(endpoint.url + "/v1/state?sessionId=bridge-setup-readiness", { headers: { authorization: `Bearer ${endpoint.token}` }, redirect: "error", signal: AbortSignal.timeout(5000) });
	if (!response.ok) throw Error("Broker authentication failed");
	const text = await response.text();
	if (text.length > 1024 * 1024) throw Error("Broker response too large");
	const state = ServerStateSchema.parse(JSON.parse(text));
	if (state.serverInstance !== lock.instance) throw Error("Authenticated broker differs from its ownership lock");
	if (!state.devices.some((device: { id: string; online: boolean }) => device.id === deviceId && device.online)) throw Error("Original signed device is not online on this broker");
	const current = await readEndpoint(`${stateDir}/server.json`);
	const currentLock = JSON.parse(await readFile(`${stateDir}/server.lock`, "utf8"));
	if (current.token !== endpoint.token || current.url !== endpoint.url || current.pid !== endpoint.pid || currentLock.instance !== lock.instance || currentLock.pid !== lock.pid) throw Error("Broker changed during proof");
	return { instance: lock.instance, credentialDigest: createHash("sha256").update(endpoint.token).digest("hex"), deviceId, registered: true };
}

export async function probeSshBroker(host: string, root: string, deviceId: string, log: string): Promise<BrokerIdentity> {
	const query = (argv: string[]) => setupCommand("ssh", sshCommand(host, argv), { log, timeout: 20000, message: "Cannot prove the selected SSH route reaches the existing live broker. Check the original approved SSH route and broker metadata; no client was replaced." });
	const file = path.posix.join(remotePath(root), "server.managed.json");
	const raw = await query(["sh", "-c", 'set -eu; test ! -L "$1"; cat "$1"', "bridge-broker-proof", file]);
	const record = z.object({ kind: z.literal("server"), packageRoot: z.string(), runtime: z.string() }).parse(JSON.parse(raw));
	const script = `(${readBrokerIdentity.toString()})(${JSON.stringify(root)},${JSON.stringify(deviceId)},${JSON.stringify(remotePath(record.packageRoot))}).then(value => console.log(JSON.stringify(value)));`;
	return BrokerIdentitySchema.parse(JSON.parse(await query([remotePath(record.runtime), "-e", script])));
}

/** Lex literal POSIX argv only; substitutions, expansion and shell operators are never evaluated. */
export function approvedBrokerRoot(remoteCommand: string): string {
	const invalid = () => new BridgeError("SERVICE_HOST_UNPROVEN", "The saved relay is not a literal managed broker route. Review the original setup before using an alias.");
	if (/[\x00-\x1f\x7f]/.test(remoteCommand)) throw invalid();
	const args: string[] = [];
	let token = "";
	let started = false;
	let quote: "'" | '"' | undefined;
	for (let i = 0; i < remoteCommand.length; i++) {
		const char = remoteCommand[i]!;
		if (quote === "'") {
			if (char === "'") quote = undefined; else token += char;
		} else if (quote === '"') {
			if (char === '"') quote = undefined;
			else if (char === "\\") {
				const next = remoteCommand[++i];
				if (next === undefined || !['"', "\\", "$", "`"].includes(next)) throw invalid();
				token += next;
			} else if (char === "$" || char === "`") throw invalid();
			else token += char;
		} else if (char === " ") {
			if (started) { args.push(token); token = ""; started = false; }
		} else if (char === "'" || char === '"') { quote = char; started = true; }
		else if (char === "\\") {
			const next = remoteCommand[++i];
			if (next === undefined) throw invalid();
			token += next; started = true;
		} else if (/^[A-Za-z0-9_./:@%+=,-]$/.test(char)) { token += char; started = true; }
		else throw invalid();
	}
	if (quote) throw invalid();
	if (started) args.push(token);
	if (args.length !== 5 || args[2] !== "relay" || args[3] !== "--state-dir" || !args[0]!.startsWith("/") || !args[1]!.startsWith("/") || path.posix.basename(args[1]!) !== "cli.ts") throw invalid();
	return remotePath(args[4]!);
}

export function proveSameBroker(health: ServiceHealth, candidate: BrokerIdentity, original?: BrokerIdentity): void {
	if (!health.connected || !health.deviceId || candidate.deviceId !== health.deviceId) throw new BridgeError("SERVICE_HOST_UNPROVEN", "The existing signed client is not connected; reconnect its original approved route before retrying alias setup.");
	if (health.serverInstance !== undefined) {
		if (health.serverInstance !== candidate.instance) throw new BridgeError("SERVICE_HOST_CONFLICT", "The selected SSH route reaches a different broker. The existing connection and recovery approval were retained; use the original route or a separate client installation.");
	} else if (!original) throw new BridgeError("SERVICE_HOST_UNPROVEN", "This legacy client has no authenticated resolved view or original recovery route. Open an OMP session through its original host so its broker state becomes available, then retry; no re-registration is needed.");
	if (original && (original.deviceId !== health.deviceId || original.instance !== candidate.instance || original.credentialDigest !== candidate.credentialDigest)) throw new BridgeError("SERVICE_HOST_CONFLICT", "The selected and originally approved SSH routes reach different live brokers. No client, broker or recovery approval was replaced.");
}

export interface ExistingClientRoute {
	host: string;
	preserveApproval: boolean;
	plan?: ClientResumePlan;
	verify(health: ServiceHealth): Promise<void>;
}

/** Preflight precedes all remote provisioning. A live but unprovable client is never retargeted. */
export async function admitExistingClientRoute(options: { pluginData: string; stateDir: string; host: string; remoteRoot: string; log: string }, probe = probeSshBroker): Promise<ExistingClientRoute | undefined> {
	const record = z.object({ pid: z.number().int().positive(), host: z.string().optional() }).optional().parse(await readOptionalJson(path.join(options.stateDir, "client.managed.json")));
	let health: ServiceHealth;
	try { health = await serviceHealth("client", options.stateDir); }
	catch {
		const endpoint = await readEndpoint(path.join(options.stateDir, "client.json")).catch(() => undefined);
		if ((record && processExists(record.pid)) || (endpoint?.pid && processExists(endpoint.pid))) throw new BridgeError("SERVICE_HOST_UNPROVEN", "The existing client is alive but cannot authenticate its connection. Restore its original route and retry; setup did not provision a remote broker or replace the client.");
		return undefined;
	}
	const rawPlan = await readOptionalJson(path.join(options.pluginData, "client-resume.json"));
	const plan = rawPlan === undefined ? undefined : ClientResumePlanSchema.parse(rawPlan);
	if (plan && (plan.stateDir !== options.stateDir || plan.controlFile !== path.join(options.stateDir, "client.json") || plan.deviceId !== health.deviceId || (record?.host && record.host !== plan.host) || (record && record.pid !== health.endpoint.pid))) throw new BridgeError("SERVICE_HOST_UNPROVEN", "The current client and saved recovery approval disagree. Review the original installation; setup will not rewrite its grant.");
	if (!plan && (!record?.host || record.pid !== health.endpoint.pid || await readOptionalJson(path.join(options.pluginData, "client-resume-initialized.json")) !== undefined)) throw new BridgeError("SERVICE_HOST_UNPROVEN", "The original client route is missing or its recovery approval was revoked. Review the original installation before alias setup; no remote service was provisioned.");
	const originalRoot = plan ? approvedBrokerRoot(plan.remoteCommand) : undefined;
	const verify = async (current: ServiceHealth) => {
		if (current.endpoint.pid !== health.endpoint.pid || current.endpoint.token !== health.endpoint.token || current.endpoint.url !== health.endpoint.url || current.deviceId !== health.deviceId || JSON.stringify(await readOptionalJson(path.join(options.pluginData, "client-resume.json"))) !== JSON.stringify(rawPlan)) throw new BridgeError("SERVICE_HOST_UNPROVEN", "The live client or its recovery approval changed during setup. Retry without replacing the original connection.");
		try {
			const candidate = await probe(options.host, options.remoteRoot, current.deviceId!, options.log);
			const original = plan && !current.serverInstance ? await probe(plan.host, originalRoot!, current.deviceId!, options.log) : undefined;
			proveSameBroker(current, candidate, original);
			const latest = await serviceHealth("client", options.stateDir);
			if (!latest.connected || latest.deviceId !== current.deviceId || latest.endpoint.pid !== current.endpoint.pid || latest.endpoint.url !== current.endpoint.url || latest.endpoint.token !== current.endpoint.token || latest.serverInstance !== current.serverInstance || JSON.stringify(await readOptionalJson(path.join(options.pluginData, "client-resume.json"))) !== JSON.stringify(rawPlan)) throw new BridgeError("SERVICE_HOST_UNPROVEN", "The connection or approval changed while comparing brokers. Retry setup without replacing the existing client.");
		} catch (error) {
			if (error instanceof BridgeError && (error.code === "SERVICE_HOST_CONFLICT" || error.code === "SERVICE_HOST_UNPROVEN")) throw error;
			throw new BridgeError("SERVICE_HOST_UNPROVEN", "Could not authenticate the same live broker through the selected and original routes. Check trusted SSH access and the original broker's private metadata; the existing client and approval were not changed.");
		}
	};
	await verify(health);
	return { host: plan?.host ?? record!.host!, preserveApproval: plan !== undefined || record?.host !== options.host, plan, verify };
}

/** Preserve the original connection approval byte-for-byte when setup only reuses its broker. */
export async function saveSetupClientResumePlan(pluginData: string, plan: ClientResumePlan, existing?: ExistingClientRoute): Promise<void> {
	if (existing?.preserveApproval) {
		await existing.verify(await serviceHealth("client", plan.stateDir));
		return;
	}
	await saveClientResumePlan(pluginData, plan);
}
