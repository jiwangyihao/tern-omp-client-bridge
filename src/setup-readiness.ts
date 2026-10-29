// SPDX-License-Identifier: MPL-2.0
import { z } from "zod";
import type { ManagedResult } from "./setup-managed.ts";

export type PluginReloadStatus = "reloaded" | "unavailable" | "failed" | "isolated";
const PluginSnapshotSchema = z.object({
	plugins: z.array(z.object({ id: z.string(), status: z.string(), host: z.boolean().optional() })),
	problems: z.array(z.unknown()),
});

/** Exit status alone cannot establish that this plugin actually loaded. Never publish native error text. */
export function ternReloadReadiness(value: unknown): { status: "reloaded" | "failed"; message: string } {
	const snapshot = PluginSnapshotSchema.safeParse(value);
	if (!snapshot.success) return { status: "failed", message: "Tern reload returned an unrecognized plugin status. Inspect the private host setup log and native plugin list before retrying." };
	const own = snapshot.data.plugins.filter(plugin => plugin.id === "omp-client-bridge");
	if (own.length !== 1) return { status: "failed", message: "Tern reload did not identify exactly one omp-client-bridge plugin. Verify its installed directory and reload the intended daemon." };
	if (own[0]!.status !== "ready" || own[0]!.host !== true) return { status: "failed", message: "Tern reports omp-client-bridge or its host entry is not ready. Inspect this plugin's native load diagnostics in the private host setup log, resolve them and retry." };
	const unrelatedIds = snapshot.data.plugins.filter(plugin => plugin.id !== "omp-client-bridge").map(plugin => plugin.id);
	const related = snapshot.data.problems.filter(problem => {
		const text = JSON.stringify(problem) ?? "";
		if (text.includes("omp-client-bridge")) return true;
		// Ignore only problems attributable to another listed plugin. Unscoped discovery
		// failures cannot safely be declared unrelated to the bridge's host readiness.
		const metadata = z.record(z.string(), z.unknown()).safeParse(problem);
		if (!metadata.success) return true;
		return !["id", "plugin", "pluginId", "plugin_id"].some(key => {
			const owner = metadata.data[key];
			return typeof owner === "string" && unrelatedIds.includes(owner);
		});
	});
	if (related.length) return { status: "failed", message: `Tern reported ${related.length} bridge or unscoped plugin-load problem(s). Inspect the private host setup log and native plugin list, resolve those problems and retry.` };
	return { status: "reloaded", message: "Tern reports omp-client-bridge and its host entry ready, with no related load problems." };
}

export function setupReadiness(input: {
	sessionReady: boolean;
	pluginReload: PluginReloadStatus;
	pluginReloadMessage?: string;
	client: Pick<ManagedResult, "ownership" | "upgradeRequired">;
	broker: Pick<ManagedResult, "ownership" | "upgradeRequired">;
}): { status: "ready" | "awaiting_session"; stage: string; message: string } {
	const upgrade = input.client.upgradeRequired || input.broker.upgradeRequired;
	const hostReady = input.pluginReload === "reloaded";
	const ready = input.sessionReady && hostReady && !upgrade;
	const messages = [ready ? "Bridge is ready: signed registration, host plugin readiness and an actual OMP view handshake were confirmed." : "Signed client registration is confirmed; setup is not fully ready."];
	if (!input.sessionReady) messages.push("Open/select a new OMP session or explicitly reload its extension to complete the view handshake. Setup never restarts OMP sessions.");
	if (!hostReady) messages.push(input.pluginReloadMessage ?? (input.pluginReload === "isolated" ? "Host plugin reload is unverified for this isolated directory. Reload its intended Tern daemon explicitly, then retry." : "Host plugin readiness was not confirmed. Inspect its native load diagnostics, reload the intended Tern daemon and retry."));
	if (upgrade) messages.push("Updated source is installed, but retained bridge services still run an earlier version. Restart those bridge services explicitly when safe, then retry; setup preserved active OMP sessions.");
	const existing = [input.client.ownership === "existing" ? "client" : undefined, input.broker.ownership === "existing" ? "broker" : undefined].filter(value => value !== undefined);
	if (existing.length) messages.push(`Reused existing ${existing.join(" and ")}; their lifetime remains with the original terminal/service manager. Setup did not detach or restart them.`);
	messages.push("Existing device identity was retained. Bind the session manually to authorize client tools under native policy and OS permissions.");
	return { status: ready ? "ready" : "awaiting_session", stage: ready ? "ready" : upgrade ? "awaiting-service-upgrade" : !hostReady ? "awaiting-host-plugin" : "awaiting-session", message: messages.join(" ") };
}
