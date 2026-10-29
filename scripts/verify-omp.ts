// SPDX-License-Identifier: MPL-2.0
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { BridgeError } from "../src/protocol.ts";

/** Verify the installed host's loader, not a successful import in the private Bun/SDK. */
export async function verifyOmpLoader(loader: string, command: readonly string[] = ["omp"]): Promise<void> {
	// Same-volume HOME-relative configuration also works on native Windows.
	const directory = await mkdtemp(path.join(homedir(), ".bridge-loader-probe-"));
	try {
		const result = path.join(directory, "result.json");
		const probe = path.join(directory, "probe.ts");
		await writeFile(probe, `import { writeFileSync } from "node:fs";
import { loadLegacyPiModule } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat";
export default async function(api) {
 const hooks = new Set();
 try {
 const observed = new Proxy(api, { get(target, key, receiver) {
  if (key !== "on") return Reflect.get(target, key, receiver);
  // Observe registrations only. Never attach candidate lifecycle handlers to this host.
  return (event, _handler) => { hooks.add(event); };
 } });
 const loaded = await loadLegacyPiModule(${JSON.stringify(loader)});
 if (typeof loaded.default !== "function") throw Error("Bridge loader has no extension factory");
 await loaded.default(observed);
 for (const event of ["session_start", "session_switch", "tool_call", "session_shutdown"]) {
  if (!hooks.has(event)) throw Error("Bridge loader did not register " + event);
 }
 writeFileSync(${JSON.stringify(result)}, JSON.stringify({ loaded: true }), { flag: "wx", mode: 384 });
 // The driver closes stdin. Native RPC EOF handles shutdown outside the factory guard.
 } catch (error) {
  writeFileSync(${JSON.stringify(result)}, JSON.stringify({ loaded: false, error: String(error) }), { flag: "wx", mode: 384 });
 }
}
`, { mode: 0o600, flag: "wx" });
		const environment: Record<string, string | undefined> = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (!key.startsWith("PI_") && !key.startsWith("OMP_") && !key.startsWith("TERN_OMP_") && !/(?:KEY|TOKEN|SECRET)$/i.test(key)) environment[key] = value;
		}
		Object.assign(environment, {
			PI_CONFIG_DIR: path.relative(homedir(), path.join(directory, "config")),
			PI_CODING_AGENT_DIR: path.join(directory, "agent"),
			OPENAI_API_KEY: "synthetic-not-used",
			OTEL_SDK_DISABLED: "true",
		});
		const child = Bun.spawn([...command, "--mode", "rpc", "--model", "openai/gpt-4o-mini", "--no-session", "--no-skills", "--no-extensions", "--no-rules", "--no-lsp", "--no-title", "-e", probe], {
			cwd: directory, env: environment, stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 40_000,
		});
		// EOF is the native RPC shutdown contract; process.exit is forbidden in factories.
		child.stdin.end();
		try {
			const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
			if (code !== 0) throw new Error(`OMP loader probe exited ${code}: ${stderr}\n${stdout}`);
			const proof = JSON.parse(await readFile(result, "utf8"));
			if (proof.loaded !== true) throw new Error(`OMP did not accept the bridge factory: ${proof.error ?? "missing acknowledgement"}`);
		} finally {
			if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; }
		}
	} catch (error) {
		throw new BridgeError("OMP_LOADER_INCOMPATIBLE", `The installed OMP could not load the bridge through its native SDK. The existing loader was not replaced; check the OMP executable and extension compatibility, not the private dependency installation. ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
