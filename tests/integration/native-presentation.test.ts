// SPDX-License-Identifier: MPL-2.0
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { wrapRegisteredTool } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { ToolExecutionComponent, stopSharedSpinnerTicker, type ToolResultFrame } from "@oh-my-pi/pi-tui/chat/tool-execution";
import type { DescribeContext, NativeChild, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { initThemeSync } from "@oh-my-pi/pi-tui/theme";
import { toolRenderers } from "@oh-my-pi/pi-tui/tools";
import type { EditMode } from "@oh-my-pi/pi-tui/tools/edit";
import type { BrokerApi } from "../../src/api.ts";
import { installClientBridge } from "../../src/omp/extension.ts";
import { nativePresentations, type NativePresentation } from "../../src/omp/native-presentation.ts";

// Actual native registration/wrapping and native components, without execution.
// These are equal-input presentation tests: injected Edit preview frames/modes
// do NOT prove that the Bridge generates live previews through openArgStream.
// Tern must match the builtin semantic view; ANSI must retain the old Bridge's
// generic presentation, not acquire the builtin ANSI renderer.
const forbidden = (): never => { throw new Error("Presentation fixture attempted execution"); };
// RegisteredToolAdapter never needs its runner while rendering. Any accidental
// access fails rather than constructing an execution-capable session fixture.
const runner = new Proxy({} as ExtensionRunner, { get: forbidden });
const ui = { requestRender() {}, requestComponentRender() {}, resetDisplay() {} };
const components: ToolExecutionComponent[] = [];
let restoreClock: () => void;
beforeEach(() => {
	initThemeSync();
	// Freeze only the presentation clock, retaining all text, whitespace, ANSI,
	// elapsed properties and statuses in comparisons. Never scrub whole nodes.
	const clock = spyOn(performance, "now").mockReturnValue(12_000);
	restoreClock = () => clock.mockRestore();
});
afterEach(() => {
	for (const component of components.splice(0)) component.seal();
	stopSharedSpinnerTicker();
	restoreClock();
});

type Name = "bash" | "edit" | "read" | "write" | "grep" | "glob" | "eval";
type Scenario = {
	name: string;
	tool: Name;
	args: Record<string, unknown>;
	result?: ToolResultFrame;
	partial?: boolean;
	cancelled?: boolean;
	mode?: EditMode;
	preview?: { streaming: boolean; files: Array<{ path: string; diff?: string; firstChangedLine?: number; error?: string }> };
};
const lines = Array.from({ length: 36 }, (_, n) => `line ${n + 1}: renderer parity`).join("\n");
const oldText = "export const value = 1;\n";
const newText = "export const value = 2;\n";
const diff = "@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;";
const text = (value: string): ToolResultFrame["content"] => [{ type: "text", text: value }];
const editResult: ToolResultFrame = {
	content: text("Updated fixture.ts"),
	details: { path: "fixture.ts", diff, firstChangedLine: 1, oldText, newText },
};
const scenarios: Scenario[] = [
	{ name: "Bash successful output", tool: "bash", args: { command: "printf fixture", timeout: 7 }, result: { content: text(lines), details: { wallTimeMs: 1250, exitCode: 0 } } },
	{ name: "Bash all text blocks and timeout context", tool: "bash", args: { command: "printf fixture", timeout: 7 }, result: { content: [...text("first block"), ...text("second block")], details: { exitCode: 0 } } },
	{ name: "Bash streaming output", tool: "bash", args: { command: "printf fixture", timeout: 7 }, partial: true, result: { content: text(lines) } },
	{ name: "Bash error and exit code", tool: "bash", args: { command: "fixture-command" }, result: { content: text("fixture: command failed"), details: { exitCode: 7, wallTimeMs: 500 }, isError: true } },
	{ name: "Bash deadline", tool: "bash", args: { command: "fixture-command", timeout: 1 }, result: { content: text("partial output"), details: { timedOut: true, timeoutSeconds: 1, wallTimeMs: 1000 } } },
	{ name: "Bash cancellation before output", tool: "bash", args: { command: "fixture-command" }, cancelled: true },
	{ name: "Bash cancellation after streamed output", tool: "bash", args: { command: "fixture-command" }, partial: true, cancelled: true, result: { content: text("retained partial output") } },
	{ name: "Bash cancelled background job", tool: "bash", args: { command: "fixture-command", async: true }, partial: true, cancelled: true, result: { content: text("retained job output"), details: { async: { type: "bash", jobId: "fixture-job", state: "cancelled" } } } },
	{ name: "Read ranged source", tool: "read", args: { path: "fixture.ts:2-37" }, result: { content: text(lines), details: { kind: "file", resolvedPath: "/fixture/fixture.ts", totalLines: 40, displayContent: { text: lines, startLine: 2 } } } },
	{ name: "Read historical text without details", tool: "read", args: { path: "fixture.ts" }, result: { content: text("export const value = 2;") } },
	{ name: "Write source preview", tool: "write", args: { path: "fixture.ts", content: lines }, result: { content: text("Wrote fixture.ts") } },
	{ name: "Write streaming source", tool: "write", args: { path: "fixture.ts", content: lines } },
	{ name: "Grep grouped matches", tool: "grep", args: { pattern: "value", path: "src" }, result: { content: text("src/fixture.ts:1:export const value = 2;"), details: { matchCount: 1, fileCount: 1, files: ["src/fixture.ts"], scopePath: "src", cwd: "/fixture", displayContent: "src/fixture.ts\n*1│export const value = 2;" } } },
	{ name: "Glob file tree", tool: "glob", args: { path: "src/**/*.ts" }, result: { content: text("src/fixture.ts\nsrc/other.ts"), details: { files: ["src/fixture.ts", "src/other.ts"], fileCount: 2, scopePath: "src", cwd: "/fixture" } } },
	{ name: "Eval completed cells and structured output", tool: "eval", args: { language: "js", code: "print({answer: 42})", title: "Inspecting fixture" }, result: { content: text(lines), details: { language: "js", cells: [{ index: 0, code: "print({answer: 42})", language: "js", output: lines, status: "complete", durationMs: 250 }], jsonOutputs: [{ answer: 42, nested: { retained: true } }] } } },
	{ name: "Eval streamed cell", tool: "eval", args: { language: "py", code: "print('fixture')" }, partial: true, result: { content: text("fixture"), details: { language: "py", cells: [{ index: 0, code: "print('fixture')", language: "py", output: "fixture", status: "running" }] } } },
	{ name: "Eval historical text blocks", tool: "eval", args: { language: "js", code: "print('fixture')" }, result: { content: [...text("first eval block"), ...text("second eval block")] } },
	{ name: "Edit replace diff", tool: "edit", mode: "replace", args: { path: "fixture.ts", oldText, newText }, result: editResult },
	{ name: "Edit patch diff", tool: "edit", mode: "patch", args: { path: "fixture.ts", op: "update", diff }, result: editResult },
	{ name: "Edit hashline diff", tool: "edit", mode: "hashline", args: { input: "[fixture.ts#A1B2]\nPUT 1.=1:\n+export const value = 2;" }, result: editResult },
	{ name: "Edit apply-patch diff", tool: "edit", mode: "apply_patch", args: { input: "*** Begin Patch\n*** Update File: fixture.ts\n@@\n-export const value = 1;\n+export const value = 2;\n*** End Patch" }, result: editResult },
	{ name: "Edit computed streaming diff", tool: "edit", mode: "hashline", args: { input: "[fixture.ts#A1B2]\nPUT 1.=1:\n+export const value = 2;" }, preview: { streaming: true, files: [{ path: "fixture.ts", diff, firstChangedLine: 1 }] } },
	{ name: "Edit result retains computed preview without details", tool: "edit", mode: "hashline", args: { input: "[fixture.ts#A1B2]\nPUT 1.=1:\n+export const value = 2;" }, preview: { streaming: false, files: [{ path: "fixture.ts", diff, firstChangedLine: 1 }] }, result: { content: text("Updated fixture.ts") } },
	{ name: "Edit preview error", tool: "edit", mode: "hashline", args: { input: "[fixture.ts#A1B2]\nPUT 1.=1:\n+changed" }, preview: { streaming: false, files: [{ path: "fixture.ts", error: "Snapshot changed" }] } },
	{ name: "Edit multiple files", tool: "edit", mode: "patch", args: { edits: [{ path: "fixture.ts", diff }, { path: "other.ts", diff }] }, result: { content: text("Updated two files"), details: { diff, perFileResults: [{ path: "fixture.ts", diff, firstChangedLine: 1 }, { path: "other.ts", diff, firstChangedLine: 1 }] } } },
];

async function registered(scenario: Scenario, presentation = true, editMode: () => EditMode | undefined = () => scenario.mode): Promise<AgentTool & Partial<NativePresentation>> {
	const extension = await loadExtensionFromFactory(api => {
		const definition = {
			name: scenario.tool, label: scenario.tool, description: "Non-executing rendering fixture",
			parameters: api.zod.object({}), execute: forbidden,
			...(presentation ? nativePresentations(api, editMode)[scenario.tool] : {}),
		};
		api.registerTool(definition);
	}, "/fixture", new EventBus(), new ExtensionRuntime(), "<native-presentation-parity>");
	const tool = extension.tools.get(scenario.tool);
	if (!tool) throw new Error(`Native loader did not register ${scenario.tool}`);
	expect(tool.sourceInfo.source).toBe("extension");
	expect(Reflect.get(tool.definition, "mode")).toBeUndefined();
	expect(Reflect.get(tool.definition, "openArgStream")).toBeUndefined();
	return wrapRegisteredTool(tool, runner) as AgentTool & Partial<NativePresentation>;
}

function component(scenario: Scenario, tool: AgentTool, builtin: boolean): ToolExecutionComponent {
	// Only the native comparison receives the builtin's mode metadata. The
	// replacement and old-Bridge ANSI baseline deliberately have neither mode
	// nor openArgStream; the helper's mode provider is semantic-only.
	const displayTool = builtin && scenario.mode ? new Proxy(tool, {
		get(target, key, receiver) { return key === "mode" ? scenario.mode : Reflect.get(target, key, receiver); },
	}) : tool;
	const value = new ToolExecutionComponent(scenario.tool, structuredClone(scenario.args), { useBuiltInRenderer: builtin, showImages: false }, displayTool, ui, "/fixture", "fixture-call");
	components.push(value);
	return value;
}
function feed(value: ToolExecutionComponent, scenario: Scenario, historical: boolean): void {
	if (!historical) value.setExecutionStarted();
	// Equal semantic inputs only; never invoke the resource-bearing stream hook.
	if (scenario.preview) value.updateStreamPreview(structuredClone(scenario.preview));
	if (scenario.result) value.updateResult(structuredClone(scenario.result), scenario.partial ?? false);
	if (scenario.cancelled) value.seal();
}
function context(cols: number, toolKind: boolean): DescribeContext {
	return { cols, reduceMotion: true, dark: true, supports: kind => kind !== "tool" || toolKind, feature: () => false };
}
function materialize(child: NativeChild, cx: DescribeContext): NativeNode {
	if (!("k" in child)) {
		if (!child.describe) throw new Error("Specialized renderer fell back to ANSI rows in a semantic tree");
		const described = child.describe(cx);
		if (!described) throw new Error("Semantic child returned no description");
		return materialize(described, cx);
	}
	return { ...child, ...(child.c ? { c: child.c.map(item => materialize(item, cx)) } : {}) };
}
function semantic(value: ToolExecutionComponent, width: number, toolKind: boolean): NativeNode {
	const cx = context(width, toolKind);
	return materialize(value.describe(cx), cx);
}
function parity(expected: ToolExecutionComponent, actual: ToolExecutionComponent, surface: "TSP" | "ANSI"): void {
	for (const expanded of [false, true]) {
		expected.setExpanded(expanded);
		actual.setExpanded(expanded);
		for (const width of [48, 100]) {
			if (surface === "TSP") {
				for (const toolKind of [true, false]) {
					expect(semantic(actual, width, toolKind)).toEqual(semantic(expected, width, toolKind));
				}
			} else {
				// Keep ANSI escapes and padding: these are consumer-visible, too.
				expect(actual.render(width)).toEqual(expected.render(width));
			}
		}
	}
}

describe("registered Bridge Tern presentation and unchanged ANSI", () => {
	for (const scenario of scenarios) {
		for (const historical of [false, true]) {
			for (const surface of ["TSP", "ANSI"] as const) {
				test(`${surface}: ${scenario.name}: ${historical ? "historical hydration" : "live updates"}`, async () => {
					const baseline = await registered(scenario, false);
					const replacement = await registered(scenario);
					const expected = component(scenario, baseline, surface === "TSP");
					const actual = component(scenario, replacement, false);
					feed(expected, scenario, historical);
					feed(actual, scenario, historical);
					parity(expected, actual, surface);
				});
			}
		}
	}

	for (const name of ["bash", "edit", "read"] as const) {
		test(`Regression control: ${name}: removing presentation reproduces the original regression`, async () => {
			const scenario = scenarios.find(item => item.tool === name && item.result)!;
			const bare = await registered(scenario, false);
			const expected = component(scenario, bare, true);
			const missing = component(scenario, bare, false);
			feed(expected, scenario, true);
			feed(missing, scenario, true);
			expect(semantic(missing, 100, true)).not.toEqual(semantic(expected, 100, true));
			expect(missing.render(100)).not.toEqual(expected.render(100));
		});
	}

	for (const name of ["bash", "eval", "edit", "read", "write", "grep", "glob"] as const) {
		test(`TSP cold result: ${name}: no preceding describeCall`, async () => {
			const scenario = scenarios.find(item => item.tool === name && item.result)!;
			const replacement = await registered(scenario);
			expect(replacement.renderCall).toBeUndefined();
			expect(replacement.renderResult).toBeUndefined();
			if (!replacement.describeResult) throw new Error(`Missing registered ${name} semantic renderer`);
			for (const expanded of [false, true]) {
				const options = { expanded, isPartial: false };
				const result = structuredClone(scenario.result!);
				const nativeOptions = scenario.mode ? { ...options, renderContext: { editMode: scenario.mode } } : options;
				const expected = toolRenderers[name]!.describeResult!(result, nativeOptions, structuredClone(scenario.args));
				const actual = replacement.describeResult(result, options, structuredClone(scenario.args));
				expect(actual).toEqual(expected);
			}
		});
	}

	for (const existingMode of [undefined, "replace"] as const) {
		test(`Edit semantic mode preserves frozen options/context (${existingMode ?? "provider fallback"})`, async () => {
			const scenario = scenarios.find(item => item.name === "Edit hashline diff")!;
			const replacement = await registered(scenario);
			const renderContext = Object.freeze({
				editMode: existingMode,
				editDiffPreview: Object.freeze({ diff, firstChangedLine: 1 }),
				retainedField: "caller-owned context",
			});
			const options = Object.freeze({ expanded: false, isPartial: false, renderContext });
			const before = structuredClone(options);
			const nativeOptions = { ...options, renderContext: { ...renderContext, editMode: existingMode ?? scenario.mode } };
			expect(replacement.describeCall!(structuredClone(scenario.args), options))
				.toEqual(toolRenderers.edit!.describeCall!(structuredClone(scenario.args), nativeOptions));
			expect(replacement.describeResult!(structuredClone(editResult), options, structuredClone(scenario.args)))
				.toEqual(toolRenderers.edit!.describeResult!(structuredClone(editResult), nativeOptions, structuredClone(scenario.args)));
			expect(options).toEqual(before);
			expect(options.renderContext).toBe(renderContext);
		});
	}

	test("Edit semantic mode provider is live without adding execution metadata", async () => {
		let mode: EditMode = "hashline";
		const hashline = scenarios.find(item => item.name === "Edit hashline diff")!;
		const replacement = await registered(hashline, true, () => mode);
		const options = Object.freeze({ expanded: false, isPartial: false });
		for (const next of ["hashline", "apply_patch", "patch", "replace"] as const) {
			mode = next;
			const scenario = scenarios.find(item => item.mode === mode && item.result)!;
			const nativeOptions = { ...options, renderContext: { editMode: mode } };
			expect(replacement.describeCall!(structuredClone(scenario.args), options))
				.toEqual(toolRenderers.edit!.describeCall!(structuredClone(scenario.args), nativeOptions));
			expect(replacement.describeResult!(structuredClone(scenario.result!), options, structuredClone(scenario.args)))
				.toEqual(toolRenderers.edit!.describeResult!(structuredClone(scenario.result!), nativeOptions, structuredClone(scenario.args)));
		}
		expect(Reflect.get(replacement, "mode")).toBeUndefined();
		expect(Reflect.get(replacement, "openArgStream")).toBeUndefined();
		expect(options).toEqual({ expanded: false, isPartial: false });
	});

	for (const mismatch of ["VERSION", "askToolRenderer"] as const) {
		test(`incompatible registry (${mismatch}) rejects before any Bridge overrides or lifecycle hooks`, async () => {
			const registrations: string[] = [];
			const hooks: string[] = [];
			const broker = new Proxy({} as BrokerApi, { get: forbidden });
			await expect(loadExtensionFromFactory(api => {
				// Change only the supplied SDK identity. Never mutate the real registry,
				// host prototype, loader or renderer implementation to emulate failure.
				const pi = new Proxy(api.pi, {
					get(target, key, receiver) {
						if (key === mismatch) return mismatch === "VERSION" ? "incompatible-fixture-version" : undefined;
						return Reflect.get(target, key, receiver);
					},
				});
				const observed = new Proxy(api, {
					get(target, key, receiver) {
						if (key === "pi") return pi;
						if (key === "registerTool") return (definition: ToolDefinition) => { registrations.push(definition.name); };
						if (key === "on") return (event: string) => { hooks.push(event); };
						return Reflect.get(target, key, receiver);
					},
				});
				installClientBridge(observed, broker);
			}, "/fixture", new EventBus(), new ExtensionRuntime(), "<incompatible-presentation>"))
				.rejects.toMatchObject({ code: "host_renderer_mismatch" });
			expect(registrations).toEqual([]);
			expect(hooks).toEqual([]);
		});
	}
});
