// SPDX-License-Identifier: MPL-2.0
import { expect, test } from "bun:test";
import { JsonLineDecoder, RpcPeer } from "../../src/wire.ts";

test("cancel reaches the active operation and late completion does not replay it", async () => {
	let client!: RpcPeer;
	let server!: RpcPeer;
	let started = 0;
	let cancelled = false;
	const entered = Promise.withResolvers<void>();
	const cancellation = Promise.withResolvers<void>();
	client = new RpcPeer(frame => queueMicrotask(() => server.receive(frame)));
	server = new RpcPeer(frame => queueMicrotask(() => client.receive(frame)), async (_method, _body, context) => {
		started++;
		entered.resolve();
		await new Promise<void>(resolve => context.signal.addEventListener("abort", () => { cancelled = true; cancellation.resolve(); resolve(); }, { once: true }));
		return "late result";
	});
	const abort = new AbortController();
	const result = client.request("execute", { operation: "fixture" }, { signal: abort.signal });
	await entered.promise;
	abort.abort();
	await expect(result).rejects.toMatchObject({ code: "CANCELLED" });
	await cancellation.promise;
	expect(cancelled).toBe(true);
	expect(started).toBe(1);
	client.close(); server.close();
});

test("disconnect after dispatch reports an unknown outcome rather than a successful result", async () => {
	const peer = new RpcPeer(() => {});
	const pending = peer.request("execute", {});
	peer.close();
	await expect(pending).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
});

test("framing handles split UTF-8 and rejects oversized frames", () => {
	const observed: unknown[] = [];
	const decoder = new JsonLineDecoder(value => observed.push(value), 128);
	const bytes = new TextEncoder().encode('{"name":"图片"}\n');
	decoder.push(bytes.subarray(0, 11)); decoder.push(bytes.subarray(11));
	expect(observed).toEqual([{ name: "图片" }]);
	expect(() => decoder.push(new Uint8Array(129).fill(65))).toThrow("frame");
});
