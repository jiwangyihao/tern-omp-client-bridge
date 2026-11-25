// SPDX-License-Identifier: MPL-2.0
import { describe, expect, test } from "bun:test";
import * as native from "@oh-my-pi/pi-coding-agent";
import { nativeMetadata, type MetadataContext } from "../../src/omp/native-metadata.ts";
import { executionIdentity } from "../../src/omp/extension.ts";

describe("actual installed native policy and context metadata", () => {
	test("reuses real Bash pattern denials rather than replacing them with an exec tier", () => {
		const settings = native.Settings.isolated({ "bash.patterns": [{ match: "synthetic-danger *", approval: "deny" }] });
		const manager = native.SessionManager.inMemory("/tmp");
		const ctx: MetadataContext = { cwd: "/tmp", hasUI: false, model: undefined, sessionManager: manager };
		const metadata = nativeMetadata({ pi: native }, () => ctx, settings);
		const approval = metadata.bash.approval;
		if (typeof approval !== "function") throw new Error("Native Bash dynamic approval resolver was lost");
		expect(approval({ command: "synthetic-danger fixture" })).toMatchObject({ policy: "deny", override: true });
		expect(approval({ command: "echo safe" })).toBe("exec");
		const concurrency = metadata.bash.concurrency;
		if (typeof concurrency !== "function") throw new Error("Native Bash concurrency resolver was lost");
		expect(concurrency({ pty: true })).toBe("exclusive");
		expect(concurrency({ pty: false })).toBe("shared");
		expect(metadata.eval.approval).toBe("exec");
		expect(metadata.eval.concurrency).toBe("exclusive");
		expect(metadata.grep.loadMode).toBe("discoverable");
	});

	test("children inherit the real root conversation while keeping distinct native execution sessions", () => {
		const parent = native.SessionManager.inMemory("/tmp");
		const child = native.SessionManager.inMemory("/tmp");
		const parentIdentity = executionIdentity({ sessionManager: parent, agent: { kind: "main", id: "Main", name: "main", depth: 0 } });
		const childIdentity = executionIdentity({ sessionManager: child, localProtocolOptions: { getSessionId: () => parent.getSessionId() }, agent: { kind: "sub", id: "Worker", name: "task", depth: 1, parentId: "Main" } });
		expect(childIdentity.sessionId).toBe(parentIdentity.sessionId);
		expect(childIdentity.contextId).not.toBe(parentIdentity.contextId);
		expect(childIdentity.contextId).toContain(child.getSessionId());
		expect(() => executionIdentity({ sessionManager: child, agent: { kind: "sub", id: "Worker", name: "task", depth: 1 } })).toThrow("parent conversation identity");
	});

	test("native child Settings overlays retain child-specific deny policies", () => {
		const child = native.SessionManager.inMemory("/tmp");
		const parentSettings = native.Settings.isolated({ "bash.patterns": [] });
		const childSettings = parentSettings.overlay({ "bash.patterns": [{ match: "synthetic-child-deny *", approval: "deny" }] });
		const metadataContext: MetadataContext = { cwd: "/tmp", hasUI: false, model: undefined, sessionManager: child };
		const metadata = nativeMetadata({ pi: native }, () => metadataContext, childSettings);
		if (typeof metadata.bash.approval !== "function") throw new Error("Missing native approval resolver");
		expect(metadata.bash.approval({ command: "synthetic-child-deny fixture" })).toMatchObject({ policy: "deny", override: true });
	});

	test("a retained Bash policy uses the current runner Settings rather than the first session", () => {
		const parent = native.Settings.isolated({ "bash.patterns": [] });
		const child = parent.overlay({ "bash.patterns": [{ match: "fixture-command *", approval: "deny" }] });
		let active = parent;
		const manager = native.SessionManager.inMemory("/tmp");
		const approval = nativeMetadata({ pi: native }, () => ({ cwd: "/tmp", hasUI: false, model: undefined, sessionManager: manager }), () => active).bash.approval;
		if (typeof approval !== "function") throw new Error("Missing native approval resolver");
		expect(approval({ command: "fixture-command example" })).toBe("exec");
		active = child;
		expect(approval({ command: "fixture-command example" })).toMatchObject({ policy: "deny", override: true });
	});

});
