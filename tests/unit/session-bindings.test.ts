// SPDX-License-Identifier: MPL-2.0
import { expect, test } from "bun:test";
import { SessionBindings } from "../../src/session-bindings.ts";
import type { DeviceDescriptor } from "../../src/protocol.ts";

const deviceA: DeviceDescriptor = { id: "device-a", name: "Client A", platform: "darwin", arch: "arm64" };
const deviceB: DeviceDescriptor = { id: "device-b", name: "Client B", platform: "win32", arch: "x64" };

test("a session can use two named clients without moving an already captured call", () => {
	const bindings = new SessionBindings();
	bindings.connect(deviceA);
	bindings.connect(deviceB);
	expect(bindings.state("conversation").clientIds).toEqual([]);
	bindings.setMembers("conversation", deviceA.id, [deviceA.id], 0);
	const first = bindings.capture("conversation", "agent", "first");
	const members = [deviceB.id, deviceA.id];
	const both = bindings.setMembers("conversation", deviceA.id, members, 1);
	members.pop();
	expect(both.clientIds).toEqual([deviceA.id, deviceB.id]);
	expect(both.change).toMatchObject({ actor: { id: deviceA.id }, previousClientIds: [deviceA.id], clientIds: both.clientIds });
	expect(bindings.setMembers("conversation", deviceB.id, [deviceB.id, deviceA.id], 2)).toBe(both);
	expect(() => bindings.capture("conversation", "agent", "anonymous")).toThrow("clientId");
	expect(bindings.capture("conversation", "agent", "on-A", deviceA.id).device.id).toBe(deviceA.id);
	expect(bindings.capture("conversation", "agent", "on-B", deviceB.id).device.id).toBe(deviceB.id);
	expect(first).toMatchObject({ bindingRevision: 1, device: deviceA });
	expect(() => bindings.capture("other", "agent", "unbound", deviceA.id)).toThrow("Select a client");
});

test("connection alone does not authorize an invocation and unbinding revokes the next target", () => {
	const bindings = new SessionBindings();
	bindings.connect(deviceA);
	expect(() => bindings.capture("conversation", "context", "before-bind")).toThrow("Select a client");
	bindings.setMembers("conversation", deviceA.id, [deviceA.id], 0);
	const captured = bindings.capture("conversation", "context", "bound");
	expect(captured.device).toMatchObject(deviceA);
	bindings.setMembers("conversation", deviceA.id, [], 1);
	expect(() => bindings.capture("conversation", "context", "after-unbind")).toThrow("Select a client");
	expect(captured.device.id).toBe(deviceA.id);
});

test("offline members stay bound, ambiguity never fails over, and stale edits cannot revoke another member", () => {
	const bindings = new SessionBindings();
	bindings.connect(deviceA);
	bindings.connect(deviceB);
	bindings.setMembers("s", deviceA.id, [deviceA.id, deviceB.id], 0);
	bindings.disconnect(deviceB.id);
	expect(() => bindings.capture("s", "ctx", "no-selector")).toThrow("clientId");
	expect(() => bindings.capture("s", "ctx", "offline", deviceB.id)).toThrow("offline");
	expect(() => bindings.setMembers("s", deviceA.id, [], 0)).toThrow("refresh");
	expect(bindings.state("s").clientIds).toEqual([deviceA.id, deviceB.id]);
	bindings.setMembers("s", deviceA.id, [deviceA.id], 1);
	expect(bindings.capture("s", "ctx", "only-one").device.id).toBe(deviceA.id);
	expect(() => bindings.capture("s", "ctx", "removed", deviceB.id)).toThrow("not bound");
	expect(() => bindings.setMembers("s", deviceA.id, [deviceA.id, deviceB.id], 2)).toThrow("not connected");
	expect(() => bindings.setMembers("s", deviceA.id, [deviceA.id, deviceA.id], 2)).toThrow("Duplicate");
	expect(bindings.state("s").revision).toBe(2);
});
