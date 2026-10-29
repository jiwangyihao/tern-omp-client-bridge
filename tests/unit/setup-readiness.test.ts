// SPDX-License-Identifier: MPL-2.0
import { expect, test } from "bun:test";
import { setupReadiness, ternReloadReadiness } from "../../src/setup-readiness.ts";

const managed = { ownership: "managed", upgradeRequired: false } as const;

test("native reload needs the actual bridge host entry ready, not merely exit success", () => {
	for (const value of [undefined, {}, { plugins: [], problems: [] }, { plugins: [{ id: "omp-client-bridge", status: "failed", host: true }], problems: [] }, { plugins: [{ id: "omp-client-bridge", status: "ready", host: false }], problems: [] }]) {
		expect(ternReloadReadiness(value).status).toBe("failed");
	}
	expect(ternReloadReadiness({ plugins: [{ id: "omp-client-bridge", status: "ready", host: true }], problems: [] }).status).toBe("reloaded");
});

test("bridge and unscoped reload problems block readiness without publishing raw diagnostics", () => {
	const plugins = [{ id: "omp-client-bridge", status: "ready", host: true }, { id: "other-plugin", status: "failed", host: true }];
	const own = ternReloadReadiness({ plugins, problems: [{ id: "omp-client-bridge", error: "private-diagnostic-marker" }] });
	expect(own.status).toBe("failed");
	expect(own.message).toContain("1 bridge or unscoped");
	expect(own.message).not.toContain("private-diagnostic-marker");
	expect(ternReloadReadiness({ plugins, problems: [{ id: "other-plugin", error: "unrelated error" }] }).status).toBe("reloaded");
	expect(ternReloadReadiness({ plugins, problems: ["unscoped discovery problem"] }).status).toBe("failed");
});

test("an OMP view handshake cannot override failed host loading or a retained older service", () => {
	for (const pluginReload of ["failed", "unavailable", "isolated"] as const) {
		const result = setupReadiness({ sessionReady: true, pluginReload, client: managed, broker: managed });
		expect(result.status).toBe("awaiting_session");
		expect(result.stage).toBe("awaiting-host-plugin");
		expect(result.message).toContain("not fully ready");
	}
	for (const owner of ["client", "broker"] as const) {
		const result = setupReadiness({ sessionReady: true, pluginReload: "reloaded", client: { ...managed, upgradeRequired: owner === "client" }, broker: { ...managed, upgradeRequired: owner === "broker" } });
		expect(result.status).toBe("awaiting_session");
		expect(result.stage).toBe("awaiting-service-upgrade");
		expect(result.message).toContain("earlier version");
	}
	expect(setupReadiness({ sessionReady: false, pluginReload: "reloaded", client: managed, broker: managed }).status).toBe("awaiting_session");
	expect(setupReadiness({ sessionReady: true, pluginReload: "reloaded", client: managed, broker: managed }).status).toBe("ready");
});

test("reused manual services explicitly retain their original lifetime owner", () => {
	const result = setupReadiness({ sessionReady: true, pluginReload: "reloaded", client: { ownership: "existing", upgradeRequired: false }, broker: { ownership: "existing", upgradeRequired: false } });
	expect(result.status).toBe("ready");
	expect(result.message).toContain("existing client and broker");
	expect(result.message).toContain("original terminal/service manager");
	expect(result.message).toContain("did not detach or restart");
	const incomplete = setupReadiness({ sessionReady: false, pluginReload: "failed", pluginReloadMessage: "x".repeat(256), client: { ownership: "existing", upgradeRequired: true }, broker: { ownership: "existing", upgradeRequired: true } });
	expect(incomplete.message.length).toBeLessThanOrEqual(1024);
});
