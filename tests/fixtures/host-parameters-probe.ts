// SPDX-License-Identifier: MPL-2.0
// Loaded by the real bundled host in an isolated subprocess; never submits a prompt.
import { writeFileSync } from "node:fs";
import type { ExtensionAPI, ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { installClientBridge } from "../../src/omp/extension.ts";
import { BrokerClient } from "../../src/broker-client.ts";

export default function hostParametersProbe(api: ExtensionAPI): void {
	const checks: Record<string, Record<string, boolean>> = {};
	const broker = new BrokerClient({ stateDir: process.env.BRIDGE_HOST_PROBE_STATE });
	const observed = new Proxy(api, {
		get(target, property, receiver) {
			if (property !== "registerTool") return Reflect.get(target, property, receiver);
			return (definition: ToolDefinition) => {
				if (definition.name === "eval" || definition.name === "bash") {
					const schema = definition.parameters;
					if (typeof schema !== "function") throw new Error("Expected the pinned host's callable native validator");
					const input = definition.name === "eval" ? { language: "js", code: "1" } : { command: "printf fixture" };
					const invalidNative = definition.name === "eval" ? { language: "ruby", code: "1" } : { command: 17 };
					checks[definition.name] = {
						defaultAllowed: schema.allows(input),
						agentAllowed: schema.allows({ ...input, target: "agent" }),
						clientAllowed: schema.allows({ ...input, target: "client" }),
						invalidTargetRejected: !schema.allows({ ...input, target: "another-device" }),
						missingNativeRequiredRejected: !schema.allows({ target: "client" }),
						invalidNativeInputRejected: !schema.allows({ ...invalidNative, target: "client" }),
					};
				}
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
