// SPDX-License-Identifier: MPL-2.0
import { expect, test } from "bun:test";
import type { ExecuteRequest, InvocationTarget, Platform, ToolResult } from "../../src/protocol.ts";
import { ClientResources, decodeClientUri, isClientUri } from "../../src/resources/index.ts";

function target(device = "client-a", platform: Platform = "darwin"): InvocationTarget {
	return { requestId: "request", sessionId: "session", contextId: "context", bindingRevision: device === "client-a" ? 1 : 2, device: { id: device, name: device, platform, arch: "test" } };
}

function nativeRead(path = "/project/a.ts", tag = "ABCD", body = "1:original"): ToolResult {
	return { content: [{ type: "text", text: `[${path}#${tag}]\n${body}` }], details: { meta: { source: { type: "path", value: path } } } };
}

function text(result: ToolResult): string {
	return result.content.filter(item => item.type === "text").map(item => item.text).join("\n");
}

function fixture(results: ToolResult[]) {
	const calls: ExecuteRequest[] = [];
	const resources = new ClientResources(async request => {
		calls.push(request);
		const result = results.shift();
		if (!result) throw new Error("Unexpected native invocation");
		return result;
	});
	return { resources, calls };
}

test("client routing recognizes malformed addresses so they never fall back", () => {
	for (const uri of ["client://other/Users/a", "client:/tmp/a", "CLIENT:///tmp/a", "client:"]) expect(isClientUri(uri)).toBe(true);
	for (const uri of ["/tmp/client:/a", "artifact://4", "https://example.test/client:/"]) expect(isClientUri(uri)).toBe(false);
	for (const uri of ["client://device/tmp/a", "client:///", "client:///bad%", "client:///x#fragment", "client://user@device/a", "client:///a%00b", "client:///a%0Ab", "client:///C:relative", "client:///C:/a%5Cb"]) {
		expect(() => decodeClientUri(uri, "win32")).toThrow();
	}
	for (const uri of ["client:/tmp/a", "client://other/a", "client:////other/a", "client:///%2Fother/a", "client:///a\nb"]) expect(() => decodeClientUri(uri, "darwin")).toThrow();
});

test("absolute paths preserve Unicode, spaces and native inline selectors on each platform", () => {
	expect(decodeClientUri("client:///Users/Example/My%20Project/%E6%96%87.ts:4-9:raw", "darwin")).toBe("/Users/Example/My Project/文.ts:4-9:raw");
	expect(decodeClientUri("client:///C:/My%20Project/%E6%96%87.ts:4,8-9", "win32")).toBe("C:\\My Project\\文.ts:4,8-9");
	expect(decodeClientUri("client:////server/share/a%20b.txt", "win32")).toBe("\\\\server\\share\\a b.txt");
	expect(decodeClientUri("client:///tmp/file.json?q=.x%26.y&raw=true", "linux")).toBe("/tmp/file.json?q=.x%26.y&raw=true");
	expect(decodeClientUri("client:///tmp/a%23b.txt", "darwin")).toBe("/tmp/a#b.txt");
});

test("write translates only the path, not source code or file content", async () => {
	const { resources, calls } = fixture([{ content: [{ type: "text", text: "written" }] }]);
	const content = '[client:///C:/x.ts#cb-pretend]\nclient:///x artifact://1 proc://bg_1\nconst source = "client:///data";';
	await resources.execute({ target: target("windows", "win32"), tool: "write", params: { path: "client:///C:/空%20间/file.ts", content } });
	expect(calls[0]?.params).toEqual({ path: "C:\\空 间\\file.ts", content });
});

test("mixed host searches and unscoped client file operations fail before invocation", async () => {
	const { resources, calls } = fixture([]);
	for (const path of ["client:///project;/agent", "client:///project;artifact://1", "client://another/project", "/agent", ""]) {
		await expect(resources.execute({ target: target(), tool: "grep", params: { path, pattern: "client:///literal" } })).rejects.toThrow();
	}
	await expect(resources.execute({ target: target(), tool: "glob", params: {} })).rejects.toThrow();
	expect(calls).toHaveLength(0);
});

test("search paths translate per target while patterns remain literal", async () => {
	const { resources, calls } = fixture([{ content: [{ type: "text", text: "No matches" }] }]);
	await resources.execute({ target: target("windows", "win32"), tool: "grep", params: { path: "client:///C:/One%20Folder/a.ts:1-9;client:///D:/二/**/*.ts", pattern: "client:///literal", case: true, skip: 3 } });
	expect(calls[0]?.params).toEqual({ path: "C:\\One Folder\\a.ts:1-9;D:\\二\\**\\*.ts", pattern: "client:///literal", case: true, skip: 3 });
});

test("same native snapshot hash on two devices produces distinct aliases and rejects old-device edits", async () => {
	const { resources, calls } = fixture([nativeRead(), nativeRead(), { content: [{ type: "text", text: "updated" }] }]);
	const first = await resources.execute({ target: target(), tool: "read", params: { path: "client:///project/a.ts" } });
	const second = await resources.execute({ target: target("client-b"), tool: "read", params: { path: "client:///project/a.ts" } });
	const oldHeader = text(first).split("\n")[0]!;
	const newHeader = text(second).split("\n")[0]!;
	expect(oldHeader).toMatch(/^\[client:\/\/\/project\/a.ts\?__bridge_snapshot=[a-f0-9-]+#ABCD\]$/);
	expect(newHeader).not.toBe(oldHeader);
	await expect(resources.execute({ target: target("client-b"), tool: "edit", params: { input: `${oldHeader}\nPUT 1.=1:\n+wrong` } })).rejects.toThrow("snapshot");
	expect(calls).toHaveLength(2);
	await resources.execute({ target: target(), tool: "edit", params: { input: `${oldHeader}\nPUT 1.=1:\n+right` } });
	expect(calls[2]?.params.input).toBe("[/project/a.ts#ABCD]\nPUT 1.=1:\n+right");
});

test("snapshot aliases are isolated by path, session and context", async () => {
	const { resources, calls } = fixture([nativeRead()]);
	const result = await resources.execute({ target: target(), tool: "read", params: { path: "client:///project/a.ts" } });
	const header = text(result).split("\n")[0]!;
	const input = `${header}\nREM`;
	for (const wrong of [{ ...target(), sessionId: "foreign" }, { ...target(), contextId: "foreign" }]) await expect(resources.execute({ target: wrong, tool: "edit", params: { input } })).rejects.toThrow();
	await expect(resources.execute({ target: target(), tool: "edit", params: { input: input.replace("a.ts", "b.ts") } })).rejects.toThrow();
	resources.forgetContext("context");
	await expect(resources.execute({ target: target(), tool: "edit", params: { input } })).rejects.toThrow();
	expect(calls).toHaveLength(1);
});

test("multi-file edits validate every section and move before any mutation, preserving addition bodies", async () => {
	const { resources, calls } = fixture([nativeRead(), nativeRead("/project/b.ts", "BEEF"), { content: [{ type: "text", text: "edited" }] }]);
	const a = text(await resources.execute({ target: target(), tool: "read", params: { path: "client:///project/a.ts" } })).split("\n")[0]!;
	const b = text(await resources.execute({ target: target(), tool: "read", params: { path: "client:///project/b.ts" } })).split("\n")[0]!;
	for (const input of [`${a}\nREM\n[/agent/b.ts#BEEF]\nREM`, `${a}\nMV /agent/moved.ts`, `${a}\nREM\n${b.replace(/\?__bridge_snapshot=[a-f0-9-]+/, "")}\nREM`]) await expect(resources.execute({ target: target(), tool: "edit", params: { input } })).rejects.toThrow();
	expect(calls).toHaveLength(2);
	const body = '+[client:///literal#ABCD]\n+MV client:///not-a-move\n+artifact://1';
	await resources.execute({ target: target(), tool: "edit", params: { input: `${a}\nPUT 1.=1:\n${body}\n${b}\nMV "client:///project/new%20name.ts"` } });
	expect(calls[2]?.params.input).toBe(`[/project/a.ts#ABCD]\nPUT 1.=1:\n${body}\n[/project/b.ts#BEEF]\nMV "/project/new name.ts"`);
});

test("raw file content resembling protocol headers is never rewritten", async () => {
	const raw = "[/project/a.ts#ABCD]\n# directory/\n## body.ts#BEEF\nartifact://1\nclient:///literal";
	const { resources } = fixture([{ content: [{ type: "text", text: raw }], details: { meta: { source: { type: "path", value: "/project/a.ts" } } } }]);
	const result = await resources.execute({ target: target(), tool: "read", params: { path: "client:///project/a.ts:raw:1-9" } });
	expect(text(result)).toBe(raw);
});

test("ordinary read body and native image data are preserved exactly", async () => {
	const body = '1:[/project/a.ts#ABCD]\n2:artifact://1\n3:client:///literal\n4:## body.ts#BEEF';
	const image = { type: "image" as const, data: "AAECA//+", mimeType: "image/png" };
	const read = nativeRead("/project/a.ts", "ABCD", body);
	read.content.push(image);
	const { resources } = fixture([read]);
	const result = await resources.execute({ target: target(), tool: "read", params: { path: "client:///project/a.ts" } });
	expect(text(result).slice(text(result).indexOf("\n") + 1)).toBe(body);
	expect(result.content[1]).toEqual(image);
	expect(read.content[0]).toEqual({ type: "text", text: `[/project/a.ts#ABCD]\n${body}` });
});

test("nested grep headers resolve against target cwd, not agent cwd, without rewriting match text", async () => {
	const { resources, calls } = fixture([{ content: [{ type: "text", text: '# src/\n## a.ts#ABCD\n*1:artifact://1\n## nested/\n### a.ts#ABCD\n 2:client:///literal' }], details: { cwd: "C:\\项目", searchPath: "C:\\项目\\src", files: ["src/a.ts", "src/nested/a.ts"] } }, { content: [{ type: "text", text: "edited" }] }]);
	const result = await resources.execute({ target: target("windows", "win32"), tool: "grep", params: { path: "client:///C:/项目/src", pattern: "literal" } });
	const headers = text(result).split("\n").filter(line => line.startsWith("[client:"));
	expect(headers).toHaveLength(2);
	expect(headers[0]).toContain("client:///C:/%E9%A1%B9%E7%9B%AE/src/a.ts?__bridge_snapshot=");
	expect(headers[1]).toContain("/src/nested/a.ts?__bridge_snapshot=");
	expect(text(result)).toContain("*1:artifact://1");
	expect(text(result)).toContain(" 2:client:///literal");
	await resources.execute({ target: target("windows", "win32"), tool: "edit", params: { input: `${headers[1]}\nPUT 2.=2:\n+changed` } });
	expect(calls[1]?.params.input).toBe("[C:\\项目\\src\\nested\\a.ts#ABCD]\nPUT 2.=2:\n+changed");
});

test("artifacts and processes retain their original owner after a binding switch", async () => {
	const code = 'display("artifact://1"); // proc://bg_1';
	const native: ToolResult = { content: [{ type: "text", text: "user output: artifact://1 and proc://bg_1" }], details: { cells: [{ code, output: "artifact://1" }], jsonOutputs: [{ path: "artifact://1" }], meta: { truncation: { artifactId: "1" } }, async: { jobId: "bg_1", state: "running", type: "eval" } } };
	const { resources, calls } = fixture([native, native, { content: [{ type: "text", text: "original output" }] }, { content: [{ type: "text", text: "stopped" }] }]);
	const a = await resources.execute({ target: target(), tool: "eval", params: { code, language: "js" } });
	const b = await resources.execute({ target: target("client-b"), tool: "eval", params: { code, language: "js" } });
	const artifact = text(a).match(/artifact:\/\/client-[a-f0-9-]+/)?.[0];
	const process = text(a).match(/proc:\/\/client-[a-f0-9-]+/)?.[0];
	expect(artifact).toBeDefined();
	expect(process).toBeDefined();
	expect(text(b)).not.toContain(artifact!);
	expect(a.content[0]).toEqual(native.content[0]);
	expect(calls[0]?.params.code).toBe(code);
	const resolved = resources.resolveOwnedHandle("session", "context", `${artifact}:4-9:raw`, "new-request");
	expect(resolved?.path).toBe("artifact://1:4-9:raw");
	expect(resolved?.target.device.id).toBe("client-a");
	expect(resolved?.target.requestId).toBe("new-request");
	await resources.execute({ target: target("client-b"), tool: "read", params: { path: artifact } });
	await resources.execute({ target: target("client-b"), tool: "write", params: { path: `${process}/kill` } });
	expect(calls[2]?.target.device.id).toBe("client-a");
	expect(calls[2]?.params.path).toBe("artifact://1");
	expect(calls[3]?.target.device.id).toBe("client-a");
	expect(calls[3]?.params.path).toBe("proc://bg_1/kill");
});

test("owned handles cannot cross contexts or sessions, traverse targets, or silently become agent resources", async () => {
	const { resources } = fixture([{ content: [{ type: "text", text: "started" }], details: { service: { name: "server", state: "running" } } }]);
	const result = await resources.execute({ target: target(), tool: "bash", params: { command: "fixture", name: "server" } });
	const handle = text(result).match(/proc:\/\/client-[a-f0-9-]+/)![0];
	for (const [sessionId, contextId, path] of [["session", "other", handle], ["other", "context", handle], ["session", "context", `${handle}/../other/kill`], ["session", "context", "proc://client-unknown"]]) expect(() => resources.resolveOwnedHandle(sessionId!, contextId!, path!, "request")).toThrow();
	expect(resources.resolveOwnedHandle("session", "context", "artifact://native-agent", "request")).toBeNull();
	expect(resources.resolveOwnedHandle("session", "context", `${handle}/mode`, "request")?.path).toBe("proc://server/mode");
	resources.forgetContext("context");
	expect(() => resources.resolveOwnedHandle("session", "context", handle, "request")).toThrow();
});

test("streamed updates map lifecycle references and preserve images, signals and final errors", async () => {
	const updates: ToolResult[] = [];
	const controller = new AbortController();
	const image = { type: "image" as const, data: "AQID", mimeType: "image/png" };
	const resources = new ClientResources(async (_request, options) => {
		expect(options?.signal).toBe(controller.signal);
		options?.onUpdate?.({ content: [image], details: { async: { jobId: "bg_2", state: "running", type: "bash" } } });
		return { content: [{ type: "text", text: "native error" }], isError: true, details: { exitCode: 17, async: { jobId: "bg_2", state: "failed", type: "bash" } } };
	});
	const final = await resources.execute({ target: target(), tool: "bash", params: { command: "fixture" } }, { signal: controller.signal, onUpdate: update => updates.push(update) });
	expect(updates[0]?.content[0]).toEqual(image);
	expect(final.isError).toBe(true);
	const handle = text(updates[0]!).match(/proc:\/\/client-[a-f0-9-]+/)![0];
	expect(text(final)).toContain(handle);
});

test("late native results cannot resurrect forgotten context handles", async () => {
	const { promise, resolve: finish } = Promise.withResolvers<ToolResult>();
	const resources = new ClientResources(() => promise);
	const pending = resources.execute({ target: target(), tool: "bash", params: { command: "fixture" } });
	resources.forgetContext("context");
	finish({ content: [{ type: "text", text: "late" }], details: { async: { jobId: "bg_1" } } });
	await expect(pending).rejects.toThrow("closed");
});
