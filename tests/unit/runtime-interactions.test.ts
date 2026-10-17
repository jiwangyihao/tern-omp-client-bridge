// SPDX-License-Identifier: MPL-2.0
import { expect, test } from "bun:test";
import { LocalInteractions } from "../../src/runtime/interactions.ts";

test("desktop confirmation fails closed without a local human channel", async () => {
	const interactions = new LocalInteractions("context");
	expect(await interactions.confirm("Control", "Exact window and action")).toBe(false);
});

test("only the offered affirmative choice authorizes control", async () => {
	const seen: string[] = [];
	const interactions = new LocalInteractions("context", async request => {
		seen.push(request.contextId, request.title, request.message);
		return { choice: "yes" };
	});
	expect(await interactions.confirm("Control", "Exact window and action")).toBe(true);
	expect(seen).toEqual(["context", "Control", "Exact window and action"]);
	const invalid = new LocalInteractions("context", async () => ({ choice: "approved remotely" }));
	expect(await invalid.confirm("Control", "Action")).toBe(false);
});

test("a late approval cannot authorize an already cancelled operation", async () => {
	const controller = new AbortController();
	const decision = Promise.withResolvers<{ choice: string }>();
	const interactions = new LocalInteractions("context", () => decision.promise);
	const pending = interactions.confirm("Control", "Action", { signal: controller.signal });
	controller.abort(new Error("operation cancelled"));
	decision.resolve({ choice: "yes" });
	await expect(pending).rejects.toThrow("operation cancelled");
});

test("unavailable local UI propagates failure instead of granting permission", async () => {
	const interactions = new LocalInteractions("context", async () => { throw new Error("local viewer offline"); });
	await expect(interactions.confirm("Control", "Action")).rejects.toThrow("local viewer offline");
});
