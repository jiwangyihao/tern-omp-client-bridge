// SPDX-License-Identifier: MPL-2.0
import { describe, expect, test } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { evalSchema } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { routeTool, withClientRouting } from "../../src/omp/routing.ts";

describe("native tool target routing", () => {
	test("extends the actual installed Eval validator without losing language/reset validation", () => {
		const schema = type(withClientRouting(evalSchema, true));
		expect(schema({ language: "js", code: "1", target: "client", reset: true })).not.toBeInstanceOf(type.errors);
		expect(schema({ language: "py", code: "print(1)" })).not.toBeInstanceOf(type.errors);
		expect(schema({ language: "ruby", code: "1", target: "client" })).toBeInstanceOf(type.errors);
		expect(schema({ language: "js", code: "1", reset: "true" })).toBeInstanceOf(type.errors);
		expect(schema({ language: "js", code: "1", target: "other-device" })).toBeInstanceOf(type.errors);
		expect(schema.allows({ language: "js", code: "1", target: "client", clientId: "client_A-1" })).toBe(true);
		for (const clientId of ["", "display name", "a".repeat(257), null, ["client_A"]]) {
			expect(schema.allows({ language: "js", code: "1", target: "client", clientId })).toBe(false);
		}
	});

	test("strips only the routing field and never rewrites native parameters", () => {
		const params = { code: "await computer.window(1)", language: "js", target: "agent", reset: true, timeout: 0 };
		expect(routeTool("eval", params)).toEqual({ client: false, params: { code: params.code, language: "js", reset: true, timeout: 0 } });
		expect(params.target).toBe("agent");
		expect(routeTool("bash", { command: "pwd", target: "client", cwd: "C:\\my folder", pty: true })).toEqual({ client: true, params: { command: "pwd", cwd: "C:\\my folder", pty: true } });
		expect(() => routeTool("bash", { command: "pwd", target: "device-id" })).toThrow("target must");
	});

	test("execution selection requires a client target; unqualified agent execution is zero-copy", () => {
		for (const tool of ["eval", "bash"] as const) {
			const native = tool === "eval" ? { language: "js", code: "1" } : { command: "pwd" };
			expect(routeTool(tool, native).params).toBe(native);
			for (const target of [undefined, "agent"]) expect(() => routeTool(tool, { ...native, target, clientId: "id-A" })).toThrow("clientId requires");
			expect(routeTool(tool, { ...native, target: "client", clientId: "id-B" })).toEqual({ params: native, client: true, clientId: "id-B" });
		}
	});

	test("file selectors require Bridge resources, are singular, and never reach native input", () => {
		for (const tool of ["read", "write", "edit", "grep", "glob"] as const) {
			const args = (path: string) => tool === "edit" ? { input: "[" + path + "#ABCD]\nPUT >1:\n+x" } : { path };
			expect(() => routeTool(tool, { ...args("agent.txt"), clientId: "id-B" })).toThrow("clientId requires");
			const params = args("client:///device.txt");
			for (const clientId of ["id-A", "id-B"]) expect(routeTool(tool, { ...params, clientId })).toEqual({ client: true, params, clientId });
			expect(() => routeTool(tool, { ...params, clientId: ["id-A", "id-B"] })).toThrow("stable device ID");
		}
	});

	test("agent files and non-bridge native URIs do not consult the broker", () => {
		for (const path of ["README.md", "artifact://123", "proc://shell-1", "ssh://fixture/a", "local://notes.md"]) {
			const params = { path, i: "Reading fixture file" };
			expect(routeTool("read", params)).toEqual({ client: false, params });
			expect(routeTool("read", params).params).toBe(params);
		}
		expect(routeTool("write", { path: "local.txt", content: "client:///private/data" }).client).toBe(false);
	});

	test("reserved malformed/unknown client paths fail through the client adapter, never fall back", () => {
		for (const path of ["client:///Users/example/a", "CLIENT://foreign/path", "client:bad", "artifact://client-unknown", "proc://client-unknown/kill", "proc://client-bridge-call/id"]) {
			expect(routeTool("read", { path }).client).toBe(true);
		}
		expect(routeTool("glob", { path: "ordinary;client:///C:/Projects/**" }).client).toBe(true);
	});

	test("edit routing reads structural paths, not inserted source strings", () => {
		expect(routeTool("edit", { input: "[local.ts#ABCD]\nPUT >1:\n+const url = 'client:///secret';" }).client).toBe(false);
		expect(routeTool("edit", { input: "[client:///Users/example/a.ts?__bridge_snapshot=id#ABCD]\nPUT >1:\n+x" }).client).toBe(true);
		expect(routeTool("edit", { input: "*** Begin Patch\n*** Update File: client:///C:/Projects/a.ts\n@@\n+x\n*** End Patch" }).client).toBe(true);
	});
});
