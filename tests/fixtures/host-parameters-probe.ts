// SPDX-License-Identifier: MPL-2.0
// Loaded by the real bundled host in an isolated subprocess; never submits a prompt.
import { writeFileSync } from "node:fs";
import type { ExtensionAPI, ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { installClientBridge } from "../../src/omp/extension.ts";
import { BrokerClient } from "../../src/broker-client.ts";

export default function hostParametersProbe(api: ExtensionAPI): void {
	const checks: Record<string, Record<string, boolean>> = {};
	const broker = new BrokerClient({ stateDir: process.env.BRIDGE_HOST_PROBE_STATE });
	const path = "client:///fixture";
	const nativeInputs: Record<string, [Record<string, unknown>, Record<string, unknown>]> = {
		eval: [{ language: "js", code: "1" }, { language: "ruby", code: "1" }], bash: [{ command: "printf fixture" }, { command: 17 }],
		read: [{ path }, { path: 7 }], write: [{ path, content: "fixture" }, { path: 7 }],
		grep: [{ path, pattern: "fixture" }, { pattern: 7 }], glob: [{ path }, { path: 7 }],
		edit: [{ input: "fixture", path, edits: [], old_string: "x", new_string: "y" }, {}],
	};
	const observed = new Proxy(api, {
		get(target, property, receiver) {
			if (property !== "registerTool") return Reflect.get(target, property, receiver);
			return (definition: ToolDefinition) => {
				const schema = definition.parameters;
				if (typeof schema !== "function") throw new Error("Expected the pinned host's callable native validator");
				const [input, invalidNative] = nativeInputs[definition.name]!;
				const execution = definition.name === "eval" || definition.name === "bash";
				const client = execution ? { ...input, target: "client" } : input;
				checks[definition.name] = {
					defaultAllowed: schema.allows(input), clientAllowed: schema.allows(client),
					namedAllowed: schema.allows({ ...client, clientId: "client_A" }),
					invalidIdRejected: !schema.allows({ ...client, clientId: "device name" }),
					invalidNativeInputRejected: !schema.allows({ ...invalidNative, clientId: "client_A" }),
					...(execution ? { agentAllowed: schema.allows({ ...input, target: "agent" }),
						invalidTargetRejected: !schema.allows({ ...input, target: "another-device" }),
						missingNativeRequiredRejected: !schema.allows({ target: "client" }) } : {}),
				};
				return target.registerTool(definition);
			};
		},
	});
	installClientBridge(observed, broker);
	api.on("session_start", () => {
		const destination = process.env.BRIDGE_HOST_PROBE_RESULT;
		if (!destination) throw new Error("Missing private probe result destination");
		writeFileSync(destination, JSON.stringify(checks), { flag: "wx", mode: 0o600 });
		broker.close();
		process.exit(0);
	});
}
