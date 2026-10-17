// SPDX-License-Identifier: MPL-2.0
import { expect, test } from "bun:test";
import { SessionBindings } from "../../src/session-bindings.ts";
import type { DeviceDescriptor } from "../../src/protocol.ts";

const deviceA: DeviceDescriptor = { id: "device-a", name: "Client A", platform: "darwin", arch: "arm64", capabilities: ["files", "exec"] };
const deviceB: DeviceDescriptor = { id: "device-b", name: "Client B", platform: "win32", arch: "x64", capabilities: ["files", "exec"] };

test("a manual switch changes the next invocation, not the already captured target", () => {
	const bindings = new SessionBindings();
	bindings.connect(deviceA);
	bindings.connect(deviceB);
	expect(bindings.state("conversation").clientId).toBeNull();
	bindings.select("conversation", "device-a", "device-a", 0);
	const inFlight = bindings.capture("conversation", "agent-context", "operation-1");
	bindings.select("conversation", "device-a", "device-b", 1);
	const next = bindings.capture("conversation", "agent-context", "operation-2");
	expect(inFlight.device.id).toBe("device-a");
	expect(inFlight.bindingRevision).toBe(1);
	expect(next.device.id).toBe("device-b");
	expect(next.bindingRevision).toBe(2);
	expect(bindings.state("conversation").change?.actor.id).toBe("device-a");
	expect(bindings.state("unrelated-conversation").clientId).toBeNull();
});
