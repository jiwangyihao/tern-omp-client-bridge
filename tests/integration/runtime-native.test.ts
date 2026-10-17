// SPDX-License-Identifier: MPL-2.0
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectRuntimeEnvironment, OmpRuntime, type OmpRuntimeOptions } from "../../src/runtime/index.ts";
import { BridgeError, type Capability, type DeviceDescriptor, type ExecuteRequest, type ToolName, type ToolParameters, type ToolResult } from "../../src/protocol.ts";
import type { InteractionDecision } from "../../src/api.ts";
import { isRecord } from "../../src/json.ts";

const fixtures: Array<{ runtime: OmpRuntime; root: string }> = [];
const platform = process.platform;
if (platform !== "darwin" && platform !== "win32" && platform !== "linux") throw new Error(`Unsupported test platform ${platform}`);
const device: DeviceDescriptor = { id: "fixture-client", name: "Fixture client", platform, arch: process.arch, capabilities: ["files", "exec"] };

async function fixture(capabilities: readonly Capability[] = ["files", "exec"], onInteraction?: OmpRuntimeOptions["onInteraction"]) {
	const root = await mkdtemp(join(tmpdir(), "client-runtime-"));
	const cwd = join(root, "workspace 空间");
	await mkdir(cwd);
	const runtime = new OmpRuntime({ stateDir: join(root, "state"), cwd, capabilities, onInteraction });
	fixtures.push({ runtime, root });
	return { runtime, root, cwd };
}

function request(tool: ToolName, params: ToolParameters, contextId = "main", sessionId = "conversation"): ExecuteRequest {
	return { tool, params, target: { requestId: crypto.randomUUID(), sessionId, contextId, bindingRevision: 1, device } };
}

function text(result: ToolResult): string {
	return result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
}

async function cell(runtime: OmpRuntime, code: string, contextId = "main", language: "js" | "py" = "js", reset = false) {
	const result = await runtime.execute(request("eval", { code, language, reset, timeout: 30 }, contextId));
	expect(result.isError).not.toBe(true);
	return text(result);
}

// Await the executor's existing 15s bounded cleanup result instead of abandoning
// it at Bun's default 5s hook deadline and overlapping the next test's workers.
afterEach(async () => {
	for (const entry of fixtures.splice(0)) {
		await entry.runtime.close();
		await rm(entry.root, { recursive: true, force: true });
	}
}, 20_000);

test("real JS kernels survive context switching, isolate owners, and reset only the selected kernel", async () => {
	const { runtime } = await fixture();
	await cell(runtime, "globalThis.counter = 40; globalThis.next = () => ++counter", "a");
	await cell(runtime, "globalThis.counter = 900", "b");
	expect(await cell(runtime, "display(next())", "a")).toContain("41");
	expect(await cell(runtime, "display(counter)", "b")).toContain("900");
	expect(await cell(runtime, "display(typeof counter)", "b", "js", true)).toContain("undefined");
	expect(await cell(runtime, "display(next())", "a")).toContain("42");
	const otherSession = await runtime.execute(request("eval", { language: "js", code: "display(typeof counter)" }, "a", "another-conversation"));
	expect(text(otherSession)).toContain("undefined");
	await runtime.disposeContext("b");
	expect(await cell(runtime, "display(next())", "a")).toContain("43");
}, 90_000);

test("real Python kernels retain variables and functions independently of JS and reset", async () => {
	const { runtime } = await fixture();
	await cell(runtime, "counter = 12\ndef square():\n    return counter * counter", "a", "py");
	await cell(runtime, "counter = 5", "b", "py");
	await cell(runtime, "globalThis.counter = 70", "a", "js");
	expect(await cell(runtime, "print(square())", "a", "py")).toContain("144");
	expect(await cell(runtime, "print(counter)", "b", "py")).toContain("5");
	expect(await cell(runtime, "print('counter' in globals())", "a", "py", true)).toContain("False");
	expect(await cell(runtime, "display(counter)", "a", "js")).toContain("70");
	expect(await cell(runtime, "print(counter)", "b", "py")).toContain("5");
}, 120_000);

test("native file tools and nested Eval helpers use the client filesystem and preserve images", async () => {
	const { runtime, cwd } = await fixture();
	const path = join(cwd, "文本 fixture.txt");
	await runtime.execute(request("write", { path, content: "first\nsecond\nthird\n" }));
	const read = await runtime.execute(request("read", { path: `${path}:1-3` }));
	expect(text(read)).toContain("second");
	const header = text(read).match(/\[[^\]\r\n]+#[A-Fa-f0-9]{4}\]/)?.[0];
	expect(header).toBeDefined();
	const edited = await runtime.execute(request("edit", { input: `${header}\nPUT 2.=2:\n+changed` }));
	expect(edited.isError).not.toBe(true);
	expect(await readFile(path, "utf8")).toBe("first\nchanged\nthird\n");
	expect(text(await runtime.execute(request("grep", { path: cwd, pattern: "changed" })))).toContain("changed");
	expect(text(await runtime.execute(request("glob", { path: join(cwd, "*.txt") })))).toContain("文本 fixture.txt");
	await cell(runtime, 'await tool.write({path:"nested.txt",content:"client-owned"}); display(await tool.read({path:"nested.txt:raw"}))');
	expect(await readFile(join(cwd, "nested.txt"), "utf8")).toBe("client-owned");
	await cell(runtime, 'write("python-local.txt", "python-owned")\nprint(read("python-local.txt"))', "main", "py");
	expect(await readFile(join(cwd, "python-local.txt"), "utf8")).toBe("python-owned");
	expect(await cell(runtime, 'display(await tool.read({path:"xd://eval/helpers"}))')).toContain("load");
	const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
	const imagePath = join(cwd, "fixture.png");
	await writeFile(imagePath, png);
	const image = await runtime.execute(request("read", { path: imagePath }));
	const block = image.content.find(block => block.type === "image");
	if (!block) throw new Error("Native read did not return image bytes");
	const decoded = new Bun.Image(Buffer.from(block.data, "base64"));
	const metadata = await decoded.metadata();
	expect(metadata.width).toBeGreaterThan(0);
	expect(metadata.height).toBe(metadata.width);
	expect((await decoded.png().bytes()).length).toBeGreaterThan(0);
	expect(await readFile(imagePath)).toEqual(png);
}, 120_000);

test("native language errors and unavailable reasoning helpers remain errors", async () => {
	const { runtime } = await fixture();
	const invalid = await runtime.execute(request("eval", { language: "js", code: 'throw new Error("fixture failure")' }));
	expect(invalid.isError).toBe(true);
	expect(text(invalid)).toContain("fixture failure");
	const model = await runtime.execute(request("eval", { language: "js", code: 'await completion("Do not send a model request")' }));
	expect(model.isError).toBe(true);
	const agent = await runtime.execute(request("eval", { language: "js", code: 'await agent("Do not create a reasoning session")' }));
	expect(agent.isError).toBe(true);
	expect(await cell(runtime, "display(6 * 7)")).toContain("42");
}, 90_000);

test("capability grants and closed lifetimes reject rather than fallback to another context", async () => {
	const { runtime, cwd } = await fixture(["files"]);
	await expect(runtime.execute(request("bash", { command: "should never execute" }))).rejects.toThrow("not granted");
	await runtime.execute(request("write", { path: join(cwd, "kept.txt"), content: "owned file" }));
	await runtime.close();
	await expect(runtime.execute(request("read", { path: join(cwd, "kept.txt") }))).rejects.toThrow("closed");
	expect(await readFile(join(cwd, "kept.txt"), "utf8")).toBe("owned file");
}, 60_000);

test("desktop and browser native preludes cannot proceed without local human approval", async () => {
	const { runtime } = await fixture(["files", "exec", "computer", "browser"]);
	// Both are rejected at the prelude approval boundary, before touching a real desktop/browser.
	const desktop = await runtime.execute(request("eval", { language: "js", code: "await computer.capabilities()" }));
	expect(desktop.isError).toBe(true);
	expect(text(desktop)).toContain("no interactive UI");
	const browser = await runtime.execute(request("eval", { language: "js", code: "await browser.tabs()" }));
	expect(browser.isError).toBe(true);
	expect(text(browser)).toContain("no interactive UI");
}, 90_000);

test("native shell retains its own environment, streams output, preserves failure and cancellation", async () => {
	const { runtime, cwd } = await fixture();
	await runtime.execute(request("bash", { command: "export CLIENT_RUNTIME_NUMBER=19" }, "a"));
	await runtime.execute(request("bash", { command: "export CLIENT_RUNTIME_NUMBER=81" }, "b"));
	// Ordinary SDK Bash uses its native embedded POSIX shell, including on Windows.
	// The fixture executable itself uses native Bun, native paths and native process I/O.
	const program = join(cwd, "process fixture.ts");
	await writeFile(program, 'console.log("value=" + process.env.CLIENT_RUNTIME_NUMBER); console.error("fixture-stderr"); process.exit(7);');
	const command = `${JSON.stringify(process.execPath.replaceAll("\\", "/"))} ${JSON.stringify(program.replaceAll("\\", "/"))}`;
	const updates: string[] = [];
	const result = await runtime.execute(request("bash", { command, timeout: 10 }, "a"), { onUpdate: result => updates.push(text(result)) });
	expect(text(result)).toContain("value=19");
	expect(text(result)).toContain("fixture-stderr");
	expect(updates.some(update => update.includes("value=19"))).toBe(true);
	expect(result.isError).toBe(true);
	expect(result.details).toMatchObject({ exitCode: 7 });
	expect(text(await runtime.execute(request("bash", { command, timeout: 10 }, "b")))).toContain("value=81");
	const waiting = join(cwd, "waiting.ts");
	// This integration deliberately exercises native process cancellation/deadlines;
	// JavaScript fake timers cannot advance a separate OS process or the native shell clock.
	await writeFile(waiting, 'const server = Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response("fixture")}); console.log("fixture-started"); await Promise.withResolvers().promise; console.log("must-not-complete");');
	const waitingCommand = `${JSON.stringify(process.execPath.replaceAll("\\", "/"))} ${JSON.stringify(waiting.replaceAll("\\", "/"))}`;
	const controller = new AbortController();
	const cancelled = runtime.execute(request("bash", { command: waitingCommand, timeout: 0 }, "a"), {
		signal: controller.signal,
		onUpdate: result => { if (text(result).includes("fixture-started")) controller.abort(new Error("fixture cancel")); },
	});
	await expect(cancelled).rejects.toThrow(/cancel|abort/i);
	const timedOut = await runtime.execute(request("bash", { command: waitingCommand, timeout: 1 }, "b"));
	expect(timedOut.isError).toBe(true);
	expect(timedOut.details).toMatchObject({ timedOut: true });
	expect(text(timedOut)).not.toContain("must-not-complete");
}, 90_000);

test("native background output artifacts remain complete and context-owned", async () => {
	const { runtime, cwd } = await fixture();
	const program = join(cwd, "large-output.ts");
	await writeFile(program, 'for (let index=0; index<5000; index++) console.log("row-" + index + ":" + "x".repeat(100)); console.log("owned-final-marker");');
	const command = `${JSON.stringify(process.execPath.replaceAll("\\", "/"))} ${JSON.stringify(program.replaceAll("\\", "/"))}`;
	const settled = Promise.withResolvers<ToolResult>();
	const result = await runtime.execute(request("bash", { command, async: true, timeout: 10 }, "a"), {
		onUpdate: result => {
			const details = result.details;
			if (details && typeof details === "object" && "async" in details && details.async && typeof details.async === "object" && "state" in details.async && details.async.state === "completed") settled.resolve(result);
		},
	});
	const details = result.details;
	if (!details || typeof details !== "object" || !("async" in details) || !details.async || typeof details.async !== "object" || !("jobId" in details.async)) throw new Error("Native background job metadata missing");
	const final = await settled.promise;
	expect(text(final)).toContain("owned-final-marker");
	const artifact = text(final).match(/artifact:\/\/(\d+)/)?.[1];
	expect(artifact).toBeDefined();
	expect(text(await runtime.execute(request("read", { path: `artifact://${artifact}:raw:-2` }, "a")))).toContain("owned-final-marker");
	const foreign = await runtime.execute(request("read", { path: `artifact://${artifact}:raw:-2` }, "b")).then(
		result => ({ kind: "result" as const, result }),
		(error: unknown) => ({ kind: "error" as const, error }),
	);
	if (foreign.kind === "result") {
		expect(foreign.result.isError).toBe(true);
		expect(text(foreign.result).toLowerCase()).toContain("artifact");
	} else {
		if (!(foreign.error instanceof BridgeError)) throw foreign.error;
		expect(foreign.error.code).toBe("native_tool_error");
		expect(foreign.error.message.toLowerCase()).toContain("artifact");
	}
}, 90_000);

test("unnamed PTY calls fail explicitly rather than silently losing terminal semantics", async () => {
	const { runtime } = await fixture();
	await expect(runtime.execute(request("bash", { command: "unused", pty: true }))).rejects.toThrow("native managed PTY");
}, 60_000);

test("real managed PTYs accept stdin and keep same-named services isolated", async () => {
	const { runtime, cwd } = await fixture();
	const program = join(cwd, "terminal.ts");
	await writeFile(program, 'console.log("PTY-ready:" + process.stdin.isTTY); process.stdin.on("data", bytes => { const value = bytes.toString().trim(); process.stdout.write("accepted:" + value + "\\n", () => process.exit(0)); });');
	const command = `${JSON.stringify(process.execPath.replaceAll("\\", "/"))} ${JSON.stringify(program.replaceAll("\\", "/"))}`;
	const accepted = Promise.withResolvers<void>();
	const survived = Promise.withResolvers<void>();
	for (const contextId of ["a", "b"]) {
		const started = await runtime.execute(request("bash", { command, name: "fixture-terminal", pty: true, ready: { log: "PTY-ready:true", timeout: 10 } }, contextId), { onBackgroundResult: () => { if (contextId === "a") accepted.resolve(); else survived.resolve(); } });
		expect(text(started)).toContain("PTY-ready:true");
		expect(started.isError).not.toBe(true);
	}
	await runtime.execute(request("write", { path: "proc://fixture-terminal", content: "owner-a\n" }, "a"));
	await accepted.promise;
	expect(text(await runtime.execute(request("read", { path: "proc://fixture-terminal" }, "a")))).toContain("accepted:owner-a");
	expect(text(await runtime.execute(request("read", { path: "proc://fixture-terminal" }, "b")))).not.toContain("accepted:owner-a");
	await runtime.execute(request("bash", { command, name: "fixture-terminal", pty: true, ready: { log: "PTY-ready:true", timeout: 10 } }, "a"));
	await runtime.execute(request("write", { path: "proc://fixture-terminal/kill" }, "a"));
	await runtime.disposeContext("a");
	await runtime.execute(request("write", { path: "proc://fixture-terminal", content: "owner-b\n" }, "b"));
	await survived.promise;
	expect(text(await runtime.execute(request("read", { path: "proc://fixture-terminal" }, "b")))).toContain("accepted:owner-b");
}, 120_000);

test("native prelude approvals reach the local interaction channel and respect denial", async () => {
	const titles: string[] = [];
	const { runtime } = await fixture(["files", "exec", "computer"], async request => {
		titles.push(request.title);
		expect(request.contextId).toBe("main");
		return { choice: "no" };
	});
	// Denial happens before any desktop backend is opened; this exercises real SDK approval + IPC.
	const result = await runtime.execute(request("eval", { language: "js", code: "await computer.capabilities()" }));
	expect(result.isError).toBe(true);
	expect(text(result)).toContain("denied");
	expect(titles).toEqual(["Approve client operation?"]);
}, 90_000);

test("environment discovery reports native shell selection without mutating parent SDK roots", async () => {
	const { cwd } = await fixture();
	const previousConfigRoot = process.env.PI_CONFIG_DIR;
	const previousAgentRoot = process.env.PI_CODING_AGENT_DIR;
	const info = await inspectRuntimeEnvironment(cwd);
	expect(info.cwd).toBe(cwd);
	expect(info.platform).toBe(platform);
	expect(info.ordinaryShell).toMatchObject({ backend: "native-brush", syntax: "POSIX", persistence: "per-context" });
	expect((await stat(info.serviceShell.executable)).isFile()).toBe(true);
	expect(info.adb.deviceAccess).toBe("not-probed");
	expect(info.browser.availability).toBe("not-probed");
	expect(info.computer.availability).toBe("not-probed");
	expect(process.env.PI_CONFIG_DIR).toBe(previousConfigRoot);
	expect(process.env.PI_CODING_AGENT_DIR).toBe(previousAgentRoot);
}, 60_000);

test("background Eval keeps its permission owner while another language's foreground cell is cancelled", async () => {
	const prompt = Promise.withResolvers<AbortSignal>();
	const decision = Promise.withResolvers<InteractionDecision>();
	const backgroundEntered = Promise.withResolvers<void>();
	const foregroundEntered = Promise.withResolvers<void>();
	const releaseBackground = Promise.withResolvers<Response>();
	const releaseForeground = Promise.withResolvers<Response>();
	const backgroundFinished = Promise.withResolvers<ToolResult>();
	const { runtime, cwd } = await fixture(["files", "exec", "computer"], async (_request, signal) => {
		if (!signal) throw new Error("Local permission request has no cancellation signal");
		prompt.resolve(signal);
		return decision.promise;
	});
	await mkdir(join(cwd, ".omp"));
	await writeFile(join(cwd, ".omp", "config.yml"), "eval:\n  autoBackground:\n    enabled: true\n    thresholdMs: 5000\n");
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => {
		if (new URL(request.url).pathname === "/background") { backgroundEntered.resolve(); return releaseBackground.promise; }
		foregroundEntered.resolve();
		return releaseForeground.promise;
	} });
	try {
		for (const language of ["js", "py"] as const) {
			const observed = Promise.withResolvers<void>();
			const marker = `warm-${language}`;
			const warm = await runtime.execute(request("eval", { language, code: language === "js" ? `console.log(${JSON.stringify(marker)})` : `print(${JSON.stringify(marker)})`, timeout: 30 }), {
				onUpdate: result => { if (text(result).includes(marker)) observed.resolve(); },
				onBackgroundResult: result => { if (text(result).includes(marker)) observed.resolve(); else observed.reject(new Error(text(result))); },
			});
			if (text(warm).includes(marker)) observed.resolve();
			expect(warm.isError).not.toBe(true);
			await observed.promise;
		}
		// Native auto-backgrounding uses the real subprocess clock. The two-second
		// cell's foreground wait is one second; host-tool waiting pauses its Eval deadline.
		// The test synchronizes on actual requests/results, never guessed sleep intervals.
		const backgroundStart = runtime.execute(request("eval", {
			language: "js", timeout: 2,
			code: `await tool.read({path:${JSON.stringify(`${server.url}background`)}}); try { await computer.capabilities(); } catch (error) { console.log("background-permission:" + String(error)); }`,
		}), { onBackgroundResult: result => backgroundFinished.resolve(result) });
		await backgroundEntered.promise;
		const started = await backgroundStart;
		expect(isRecord(started.details) && isRecord(started.details.async) && started.details.async.state).toBe("running");
		const controller = new AbortController();
		const foreground = runtime.execute(request("eval", { language: "py", timeout: 30, code: `read(${JSON.stringify(`${server.url}foreground`)})\nprint("foreground-ended")` }), { signal: controller.signal });
		await Promise.race([foregroundEntered.promise, foreground.then(result => { throw new Error(`Foreground ended before its fixture request: ${text(result)}`); })]);
		releaseBackground.resolve(new Response("continue"));
		const permissionSignal = await Promise.race([prompt.promise, backgroundFinished.promise.then(result => { throw new Error(`Background lost its local permission path: ${text(result)}`); })]);
		controller.abort(new Error("cancel only the foreground cell"));
		await foreground.catch(() => undefined);
		expect(permissionSignal.aborted).toBe(false);
		decision.resolve({ choice: "no" });
		const completed = await backgroundFinished.promise;
		expect(text(completed)).toContain("background-permission:");
		expect(text(completed)).toContain("denied");
	} finally {
		decision.resolve({ choice: "no" });
		releaseBackground.resolve(new Response("stop"));
		releaseForeground.resolve(new Response("stop"));
		await server.stop(true);
	}
}, 120_000);

test("cancelling a queued JS cell acknowledges before unrelated background work settles and preserves both kernels", async () => {
	const { runtime, cwd } = await fixture();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<Response>();
	const backgroundFinished = Promise.withResolvers<ToolResult>();
	const controller = new AbortController();
	const markerPath = join(cwd, "cancelled-cell-must-not-run.txt");
	const barrierPath = join(cwd, "dispatch-barrier.txt");
	let queued: Promise<{ result: ToolResult } | { error: unknown }> | undefined;
	let ackTimer: NodeJS.Timeout | undefined;
	let backgroundSettled = false;
	await mkdir(join(cwd, ".omp"));
	await writeFile(join(cwd, ".omp", "config.yml"), "eval:\n  autoBackground:\n    enabled: true\n    thresholdMs: 5000\n");
	await writeFile(barrierPath, "dispatch-barrier");
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => {
		entered.resolve();
		return release.promise;
	} });
	try {
		// Wait for actual native completion even if first-start provisioning backgrounds.
		for (const language of ["js", "py"] as const) {
			const warmed = Promise.withResolvers<void>();
			const marker = `queue-warm-${language}`;
			const code = language === "js"
				? `globalThis.retainedCounter = 40; console.log(${JSON.stringify(marker)})`
				: `retained_counter = 70\nprint(${JSON.stringify(marker)})`;
			const observe = (result: ToolResult) => {
				if (result.isError) warmed.reject(new Error(text(result)));
				else if (text(result).includes(marker)) warmed.resolve();
			};
			observe(await runtime.execute(request("eval", { language, code, timeout: 30 }), {
				onUpdate: observe, onBackgroundResult: observe,
			}));
			await warmed.promise;
		}
		// Keep the first cell alive well beyond the cancellation acknowledgement bound.
		// The explicit gate and configured auto-background threshold establish ordering.
		const background = runtime.execute(request("eval", {
			language: "js", timeout: 60,
			code: `await tool.read({path:${JSON.stringify(server.url.toString())}}); console.log("background-finished:" + ++retainedCounter);`,
		}), { onBackgroundResult: result => { backgroundSettled = true; backgroundFinished.resolve(result); } });
		await Promise.race([entered.promise, background.then(result => {
			if (result.isError) throw new Error(text(result));
			return entered.promise;
		})]);
		const started = await background;
		expect(isRecord(started.details) && isRecord(started.details.async) && started.details.async.state).toBe("running");
		let queuedSettled = false;
		queued = runtime.execute(request("eval", {
			language: "js", timeout: 30,
			code: `await tool.write({path:${JSON.stringify(markerPath)},content:"cancelled code executed"});`,
		}), { signal: controller.signal }).then(
			result => { queuedSettled = true; return { result }; },
			error => { queuedSettled = true; return { error }; },
		);
		// This later native request shares the same context and ordered IPC channel,
		// but bypasses the language queue. Its completion proves dispatch has crossed
		// the worker while the first JS cell still owns the unreleased fixture gate.
		const barrier = await runtime.execute(request("read", { path: barrierPath }));
		expect(barrier.isError).not.toBe(true);
		expect(text(barrier)).toContain("dispatch-barrier");
		expect(queuedSettled).toBe(false);
		expect(backgroundSettled).toBe(false);
		controller.abort(new Error("cancel only queued JS"));
		// This bounds acknowledgement from a real subprocess, not race setup:
		// parent fake timers cannot drive the worker's IPC or native clock.
		const deadline = new Promise<never>((_resolve, reject) => {
			ackTimer = setTimeout(() => reject(new Error("Queued JS cancellation was not acknowledged before releasing unrelated background work")), 2_000);
		});
		const cancelled = await Promise.race([queued, deadline]);
		clearTimeout(ackTimer);
		if ("error" in cancelled) expect(String(cancelled.error)).toMatch(/cancel/i);
		else {
			expect(cancelled.result.isError).toBe(true);
			expect(text(cancelled.result)).toMatch(/cancel/i);
		}
		expect(backgroundSettled).toBe(false);
		release.resolve(new Response("continue owned background work"));
		const completed = await backgroundFinished.promise;
		expect(completed.isError).not.toBe(true);
		expect(text(completed)).toContain("background-finished:41");
		expect(await cell(runtime, 'console.log("retained-js:" + ++retainedCounter)')).toContain("retained-js:42");
		expect(await cell(runtime, 'print("retained-py:" + str(retained_counter))', "main", "py")).toContain("retained-py:70");
		expect(await Bun.file(markerPath).exists()).toBe(false);
	} finally {
		clearTimeout(ackTimer);
		// Release before draining the cancelled call, including on the expected red
		// path, so the ten-second context-wide abort escalation never needs to fire.
		release.resolve(new Response("fixture cleanup"));
		await queued;
		await server.stop(true);
	}
}, 120_000);

test("two nested async jobs retain their original Eval completion subscription until both finish", async () => {
	const { runtime, cwd } = await fixture();
	const firstEntered = Promise.withResolvers<void>();
	const secondEntered = Promise.withResolvers<void>();
	const releaseFirst = Promise.withResolvers<Response>();
	const releaseSecond = Promise.withResolvers<Response>();
	const firstFinished = Promise.withResolvers<void>();
	const secondFinished = Promise.withResolvers<void>();
	const completions: ToolResult[] = [];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => {
		if (new URL(request.url).pathname === "/first") { firstEntered.resolve(); return releaseFirst.promise; }
		secondEntered.resolve();
		return releaseSecond.promise;
	} });
	try {
		const program = join(cwd, "deferred-process.ts");
		await writeFile(program, 'await fetch(process.argv[2]); console.log("completed-" + process.argv[3]);');
		const commands = ["first", "second"].map(label => `${JSON.stringify(process.execPath.replaceAll("\\", "/"))} ${JSON.stringify(program.replaceAll("\\", "/"))} ${JSON.stringify(`${server.url}${label}`)} ${label}`);
		const result = await runtime.execute(request("eval", { language: "js", code: `for (const command of ${JSON.stringify(commands)}) await tool.bash({command, async:true, timeout:30}); console.log("launched-two-jobs");` }), {
			onBackgroundResult: result => {
				completions.push(result);
				if (text(result).includes("completed-first")) firstFinished.resolve();
				if (text(result).includes("completed-second")) secondFinished.resolve();
			},
		});
		expect(text(result)).toContain("launched-two-jobs");
		expect(isRecord(result.details) && "async" in result.details).toBe(false);
		await Promise.all([firstEntered.promise, secondEntered.promise]);
		releaseFirst.resolve(new Response("finish first"));
		await firstFinished.promise;
		releaseSecond.resolve(new Response("finish second"));
		await secondFinished.promise;
		expect(completions).toHaveLength(2);
	} finally {
		releaseFirst.resolve(new Response("stop"));
		releaseSecond.resolve(new Response("stop"));
		await server.stop(true);
	}
}, 120_000);

test("cancelling a native async job delivers its terminal result to the original caller", async () => {
	const { runtime, cwd } = await fixture();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<Response>();
	const completion = Promise.withResolvers<ToolResult>();
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { entered.resolve(); return release.promise; } });
	try {
		const program = join(cwd, "cancel-process.ts");
		await writeFile(program, 'await fetch(process.argv[2]); console.log("should-not-complete");');
		const command = `${JSON.stringify(process.execPath.replaceAll("\\", "/"))} ${JSON.stringify(program.replaceAll("\\", "/"))} ${JSON.stringify(server.url.toString())}`;
		const started = await runtime.execute(request("bash", { command, async: true, timeout: 30 }), { onBackgroundResult: result => completion.resolve(result) });
		if (!isRecord(started.details) || !isRecord(started.details.async) || typeof started.details.async.jobId !== "string") throw new Error("Native job identifier missing");
		await entered.promise;
		await runtime.execute(request("write", { path: `proc://${started.details.async.jobId}/kill` }));
		const cancelled = await completion.promise;
		expect(cancelled.isError).toBe(true);
		expect(text(cancelled)).not.toContain("should-not-complete");
	} finally {
		release.resolve(new Response("stop"));
		await server.stop(true);
	}
}, 90_000);

test("closing during lazy native bootstrap never dispatches a queued mutation", async () => {
	const { runtime, cwd } = await fixture(["files"]);
	const path = join(cwd, "must-not-be-written.txt");
	const pending = runtime.execute(request("write", { path, content: "must not execute" })).then(
		() => { throw new Error("Queued mutation executed after bootstrap cancellation"); },
		error => error,
	);
	await runtime.close();
	expect(String(await pending)).toContain("closed");
	expect(await Bun.file(path).exists()).toBe(false);
}, 30_000);
