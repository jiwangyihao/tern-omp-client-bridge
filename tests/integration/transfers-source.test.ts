// SPDX-License-Identifier: MPL-2.0
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { HumanTransferSource } from "../../src/transfers/source.ts";

const roots: string[] = [];
const sources: HumanTransferSource[] = [];
afterEach(async () => {
	await Promise.all(sources.splice(0).map(source => source.close()));
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function setup() {
	const root = await mkdtemp(join(tmpdir(), "bridge-transfer-"));
	roots.push(root);
	const source = new HumanTransferSource({ stateDir: root });
	sources.push(source);
	return { root, source };
}

describe("human transfer snapshots", () => {
	test("captures real binary bytes, preserves source files and isolates equal basenames", async () => {
		const { root, source } = await setup();
		await mkdir(join(root, "other"));
		const first = join(root, "图 one.bin");
		const second = join(root, "other", "图 one.bin");
		const bytes = Uint8Array.from([0, 255, 13, 10, 128]);
		await writeFile(first, bytes);
		await writeFile(second, "second");
		const captured = await source.capture({ kind: "files", paths: [first, second] });
		const files = source.files(captured.id);
		expect(files.map(file => file.name)).toEqual(["图 one.bin", "图 one.bin"]);
		expect(files[0]!.path).not.toBe(files[1]!.path);
		await writeFile(first, "changed after capture");
		expect(new Uint8Array(await readFile(files[0]!.path))).toEqual(bytes);
		expect(await readFile(files[1]!.path, "utf8")).toBe("second");
		await source.release(captured.id);
		expect(await readFile(first, "utf8")).toBe("changed after capture");
		expect(await readFile(second, "utf8")).toBe("second");
		await expect(readFile(files[0]!.path)).rejects.toThrow();
		expect(() => source.files(captured.id)).toThrow("released");
	});
	test("image bytes become an immutable PNG snapshot with the same claim and release ownership", async () => {
		const { source } = await setup();
		const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
		const controller = new AbortController();
		const pending = source.captureImage(bytes, controller.signal);
		bytes.fill(0);
		const captured = await pending;
		expect(captured).toMatchObject({ kind: "files", names: ["clipboard.png"] });
		const files = source.claim(captured.id);
		controller.abort(new Error("request ended after upload claim"));
		expect(await readFile(files[0]!.path)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
		expect(source.files(captured.id)).toBe(files);
		await source.release(captured.id);
		expect(() => source.files(captured.id)).toThrow("released");
		await expect(stat(files[0]!.path)).rejects.toMatchObject({ code: "ENOENT" });
	});
	test("abandoned image captures clean up and cancelled or empty images create nothing", async () => {
		const { root, source } = await setup();
		await expect(source.captureImage(new Uint8Array())).rejects.toThrow("empty");
		await expect(source.captureImage(new Uint8Array([1]), AbortSignal.abort(new Error("cancelled image")))).rejects.toThrow("cancelled image");
		await expect(stat(join(root, "captures"))).rejects.toMatchObject({ code: "ENOENT" });
		const controller = new AbortController();
		const captured = await source.captureImage(new Uint8Array([1, 2, 3]), controller.signal);
		const file = source.files(captured.id)[0]!;
		controller.abort();
		expect(() => source.claim(captured.id)).toThrow("released");
		await source.release(captured.id);
		await expect(stat(file.path)).rejects.toMatchObject({ code: "ENOENT" });
	});
	test("cancelled selected-file capture leaves no unreachable snapshot and preserves live captures", async () => {
		const { root, source } = await setup();
		const original = join(root, "selected 图.bin");
		const bytes = Uint8Array.from([0, 255, 13, 10, 128]);
		await writeFile(original, bytes);
		const normal = await source.capture({ kind: "files", paths: [original] });
		const normalFile = source.files(normal.id)[0]!;
		const captureRoot = dirname(dirname(normalFile.path));
		const controller = new AbortController();
		const liveController = new AbortController();
		const abandoned = source.capture({ kind: "files", paths: [original] }, controller.signal);
		const live = source.capture({ kind: "files", paths: [original] }, liveController.signal);
		const settled = Promise.allSettled([abandoned, live]);
		const cancellation = new Error("originating capture request abandoned");
		// Both calls have yielded to mkdir; cancellation precedes every snapshot copy.
		controller.abort(cancellation);
		const outcomes = await settled;
		const surviving = await live;
		const liveFile = source.files(surviving.id)[0]!;
		for (const file of [normalFile, liveFile]) {
			expect(new Uint8Array(await readFile(file.path))).toEqual(bytes);
			if (process.platform !== "win32") {
				expect((await stat(file.path)).mode & 0o777).toBe(0o600);
				expect((await stat(dirname(file.path))).mode & 0o777).toBe(0o700);
			}
		}
		expect(source.files(normal.id)).toEqual([normalFile]);
		expect(liveController.signal.aborted).toBe(false);
		expect(new Uint8Array(await readFile(original))).toEqual(bytes);
		// Check before close(): shutdown cleanup must not conceal an orphaned private copy.
		expect((await readdir(captureRoot)).sort()).toEqual([basename(dirname(normalFile.path)), basename(dirname(liveFile.path))].sort());
		expect(outcomes[0]).toMatchObject({ status: "rejected", reason: cancellation });
		await source.release(normal.id);
		expect(new Uint8Array(await readFile(liveFile.path))).toEqual(bytes);
		await source.release(surviving.id);
		expect(await readdir(captureRoot)).toEqual([]);
		expect(new Uint8Array(await readFile(original))).toEqual(bytes);
	});
	test("abandoning a completed capture before delivery invalidates it before asynchronous cleanup", async () => {
		const { root, source } = await setup();
		const original = join(root, "undelivered.txt");
		await writeFile(original, "preserve selected bytes");
		const controller = new AbortController();
		const captured = await source.capture({ kind: "files", paths: [original] }, controller.signal);
		const file = source.files(captured.id)[0]!;
		// Snapshot completion is not delivery: the originating caller can disappear before claiming it.
		controller.abort(new Error("capture response could not be delivered"));
		expect(() => source.files(captured.id)).toThrow("released");
		expect(() => source.claim(captured.id)).toThrow("released");
		// Explicit release joins the already-started abort cleanup instead of returning early.
		await source.release(captured.id);
		await expect(stat(dirname(file.path))).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readdir(dirname(dirname(file.path)))).toEqual([]);
		expect(await readFile(original, "utf8")).toBe("preserve selected bytes");
	});
	test("claiming a capture transfers cancellation ownership before a late request abort", async () => {
		const { root, source } = await setup();
		const original = join(root, "claimed.txt");
		await writeFile(original, "upload owns these bytes");
		const controller = new AbortController();
		const captured = await source.capture({ kind: "files", paths: [original] }, controller.signal);
		const claimed = source.claim(captured.id);
		controller.abort(new Error("original capture request closed after upload claimed it"));
		expect(source.files(captured.id)).toEqual(claimed);
		expect(await readFile(claimed[0]!.path, "utf8")).toBe("upload owns these bytes");
		const releasing = source.release(captured.id);
		expect(() => source.claim(captured.id)).toThrow("released");
		await releasing;
		await expect(stat(claimed[0]!.path)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readFile(original, "utf8")).toBe("upload owns these bytes");
	});
	test("an already cancelled capture creates no snapshot directory", async () => {
		const { root, source } = await setup();
		const original = join(root, "not captured.txt");
		await writeFile(original, "untouched");
		const controller = new AbortController();
		const cancellation = new Error("request already abandoned");
		controller.abort(cancellation);
		await expect(source.capture({ kind: "files", paths: [original] }, controller.signal)).rejects.toBe(cancellation);
		await expect(stat(join(root, "captures"))).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readFile(original, "utf8")).toBe("untouched");
	});
	test("rejects programmatic clipboard and malformed capture requests without creating snapshots", async () => {
		const { root, source } = await setup();
		for (const input of [{ kind: "clipboard" }, { kind: "clipboard", approved: true }, {}, null, { kind: "files", paths: [] }, { kind: "files", paths: [null] }]) {
			// Exercise the untyped caller boundary; no clipboard reader exists or is injected.
			await expect(Reflect.apply(source.capture, source, [input])).rejects.toThrow("explicitly selected file paths");
		}
		await expect(stat(join(root, "captures"))).rejects.toMatchObject({ code: "ENOENT" });
	});
	test("directory and missing-file failures keep caller-owned data untouched", async () => {
		const { root, source } = await setup();
		await expect(source.capture({ kind: "files", paths: [root] })).rejects.toThrow("regular files");
		await expect(source.capture({ kind: "files", paths: [join(root, "missing")] })).rejects.toThrow();
		await source.close();
		await expect(source.capture({ kind: "files", paths: [] })).rejects.toThrow("closed");
	});
});
