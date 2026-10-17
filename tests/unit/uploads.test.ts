// SPDX-License-Identifier: MPL-2.0
import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { UploadStore } from "../../src/uploads.ts";

const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

test("verified multi-chunk Unicode files and an empty file are published intact and survive shutdown", async () => {
	const directory = await mkdtemp(join(tmpdir(), "bridge-uploads-"));
	const store = new UploadStore(directory);
	try {
		const data = Buffer.alloc(524291);
		for (let index = 0; index < data.length; index++) data[index] = index % 251;
		const upload = await store.begin("client-a", { viewId: "view-a", sessionId: "session", draftToken: "draft", files: [{ name: "图片 with spaces.bin", size: data.length }, { name: "empty.txt", size: 0 }] });
		for (let offset = 0; offset < data.length; offset += 262144) await store.chunk("client-a", { id: upload.id, index: 0, offset, data: data.subarray(offset, offset + 262144).toString("base64") });
		const result = await store.finish("client-a", upload.id, [digest(data), digest(Buffer.alloc(0))]);
		expect(result.files[0]!.name).toBe("图片 with spaces.bin");
		expect(await readFile(result.files[0]!.path)).toEqual(data);
		expect(await readFile(result.files[1]!.path)).toEqual(Buffer.alloc(0));
		await store.close();
		expect(await readFile(result.files[0]!.path)).toEqual(data);
	} finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a valid maximum-byte Unicode filename remains transferable with a staging prefix", async () => {
	const directory = await mkdtemp(join(tmpdir(), "bridge-uploads-"));
	const store = new UploadStore(join(directory, "imports"));
	try {
		const name = "界".repeat(85);
		const source = join(directory, name);
		const data = Buffer.from("original Unicode-named file bytes\n");
		await writeFile(source, data);
		const upload = await store.begin("client-a", { viewId: "view", sessionId: "session", draftToken: "draft", files: [{ name, size: data.length }] });
		await store.chunk("client-a", { id: upload.id, index: 0, offset: 0, data: data.toString("base64") });
		const result = await store.finish("client-a", upload.id, [digest(data)]);
		const file = result.files[0]!;
		expect(file.name).toBe(name);
		expect(Buffer.byteLength(basename(file.path), "utf8")).toBeLessThanOrEqual(255);
		expect(basename(file.path)).not.toContain("\uFFFD");
		expect(await readFile(file.path)).toEqual(data);
		expect(await readFile(source)).toEqual(data);
	} finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("another client cannot append or cancel; wrong offsets do not corrupt the verified prefix", async () => {
	const directory = await mkdtemp(join(tmpdir(), "bridge-uploads-"));
	const store = new UploadStore(directory);
	try {
		const upload = await store.begin("client-a", { viewId: "view", sessionId: "session", draftToken: "draft", files: [{ name: "file.txt", size: 6 }] });
		await store.chunk("client-a", { id: upload.id, index: 0, offset: 0, data: Buffer.from("abc").toString("base64") });
		await expect(store.chunk("client-b", { id: upload.id, index: 0, offset: 3, data: "ZGVm" })).rejects.toMatchObject({ code: "UPLOAD_UNAVAILABLE" });
		await expect(store.cancel("client-b", upload.id)).rejects.toMatchObject({ code: "UPLOAD_UNAVAILABLE" });
		await expect(store.chunk("client-a", { id: upload.id, index: 0, offset: 0, data: "ZGVm" })).rejects.toMatchObject({ code: "UPLOAD_OFFSET" });
		await store.chunk("client-a", { id: upload.id, index: 0, offset: 3, data: "ZGVm" });
		const result = await store.finish("client-a", upload.id, [digest(Buffer.from("abcdef"))]);
		expect(await readFile(result.files[0]!.path, "utf8")).toBe("abcdef");
	} finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("checksum mismatch never becomes attachable and cancellation removes only owned partials", async () => {
	const directory = await mkdtemp(join(tmpdir(), "bridge-uploads-"));
	const store = new UploadStore(directory);
	try {
		const upload = await store.begin("client-a", { viewId: "view", sessionId: "session", draftToken: "draft", files: [{ name: "file.txt", size: 3 }] });
		await store.chunk("client-a", { id: upload.id, index: 0, offset: 0, data: "YWJj" });
		await expect(store.finish("client-a", upload.id, ["0".repeat(64)])).rejects.toMatchObject({ code: "UPLOAD_CHECKSUM" });
		expect(() => store.completed("client-a", upload.id)).toThrow("checksum-verified");
		await Promise.all([store.cancel("client-a", upload.id), store.cancelClient("client-a")]);
		expect(await readdir(directory)).toEqual([]);
	} finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});
