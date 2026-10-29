// SPDX-License-Identifier: MPL-2.0
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installOmp, ompLoaderSource } from "../../scripts/install.ts";
import { verifyOmpLoader } from "../../scripts/verify-omp.ts";

const entrypoint = fileURLToPath(new URL("../../src/omp/extension.ts", import.meta.url));
const bundled = process.env.BRIDGE_TEST_OMP ? [process.env.BRIDGE_TEST_OMP] : [process.execPath, fileURLToPath(new URL("../../node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js", import.meta.url))];
const roots: string[] = [];
async function fixture() {
	const root = await mkdtemp(path.join(tmpdir(), "bridge-loader ü "));
	roots.push(root);
	return root;
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test("generated loaders retain host graph edges across POSIX and Windows paths", () => {
	for (const [paths, loader, entry] of [
		[path.posix, "/home/user/agent/extensions/bridge/index.ts", "/home/user/private ü/src/omp/extension.ts"],
		[path.win32, "C:\\User\\agent\\extensions\\bridge\\index.ts", "C:\\User\\private ü\\src\\omp\\extension.ts"],
	] as const) {
		for (const state of [undefined, "private state ü"]) {
			const source = ompLoaderSource(loader, entry, state, paths);
			expect(source).toContain('from "./../../../private ü/src/omp/extension.ts"');
			expect(source).not.toContain("file:");
			if (state) expect(source).toContain('from "./../../../private ü/src/broker-client.ts"');
		}
	}
	const source = ompLoaderSource("C:\\agent\\extensions\\bridge\\index.ts", "D:\\release\\src\\omp\\extension.ts", "D:\\state", path.win32);
	expect(source).toContain('import { loadLegacyPiModule } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat"');
	expect(source).toContain(`await loadLegacyPiModule(${JSON.stringify("D:\\release\\src\\omp\\extension.ts")})`);
	expect(source).toContain(`await loadLegacyPiModule(${JSON.stringify("D:\\release\\src\\broker-client.ts")})`);
});

test("configured native OMP verifies the generated installed loader without session activation", async () => {
		const command = bundled;
		const root = await fixture();
		const stateDir = path.join(root, "untouched-state");
		// An ancestor alias changes path depth (also covers macOS /var -> /private/var).
		const physical = path.join(root, "physical", "nested");
		await mkdir(physical, { recursive: true });
		const alias = path.join(root, "alias");
		await symlink(physical, alias, process.platform === "win32" ? "junction" : "dir");
		const installed = await installOmp(path.join(alias, "agent"), { stateDir, hostCommand: command });
		expect(await readFile(installed.loader, "utf8")).toBe(ompLoaderSource(path.join(await realpath(path.dirname(installed.loader)), "index.ts"), await realpath(entrypoint), stateDir));
		expect(await readFile(installed.loader, "utf8")).not.toContain("file:");
		expect(await readdir(root)).not.toContain("untouched-state");
		// The old installer bypassed native graph traversal with this file URL.
		const old = path.join(root, "old-loader.ts");
		await writeFile(old, `export { default } from ${JSON.stringify(pathToFileURL(entrypoint).href)};\n`);
		await expect(verifyOmpLoader(old, command)).rejects.toMatchObject({ code: "OMP_LOADER_INCOMPATIBLE" });
	}, 100_000);
test("a failed host verification never replaces an existing owned loader", async () => {
	const root = await fixture();
	const agent = path.join(root, "agent");
	const directory = path.join(agent, "extensions", "tern-omp-client-bridge");
	await mkdir(directory, { recursive: true });
	const loader = path.join(directory, "index.ts");
	const original = "// Installed by tern-omp-bridge install-omp; SPDX-License-Identifier: MPL-2.0\nexport default () => {};\n";
	await writeFile(loader, original);
	await expect(installOmp(agent, { hostCommand: [path.join(root, "missing-omp")] })).rejects.toMatchObject({ code: "OMP_LOADER_INCOMPATIBLE" });
	expect(await readFile(loader, "utf8")).toBe(original);
	expect(await readdir(directory)).toEqual(["index.ts"]);
});

test("verification never attaches candidate lifecycle handlers, including a partially failed factory", async () => {
	const root = await fixture();
	const sentinel = path.join(root, "lifecycle-ran");
	for (const fails of [false, true]) {
		const loader = path.join(root, `lifecycle-${fails}.ts`);
		await writeFile(loader, `import { writeFileSync } from "node:fs";
export default function(api) {
 for (const event of ["session_start", "session_switch", "tool_call", "session_shutdown"]) {
  api.on(event, () => { writeFileSync(${JSON.stringify(sentinel)}, event); throw Error("Candidate lifecycle must never run during verification"); });
 }
 ${fails ? 'throw Error("Factory deliberately failed after registering handlers");' : ""}
}
`);
		if (fails) await expect(verifyOmpLoader(loader, bundled)).rejects.toMatchObject({ code: "OMP_LOADER_INCOMPATIBLE" });
		else await verifyOmpLoader(loader, bundled);
		expect(await readdir(root)).not.toContain("lifecycle-ran");
	}
}, 100_000);
