// SPDX-License-Identifier: MPL-2.0
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { z } from "zod";
import { defaultStateDir } from "../src/config.ts";
import { BridgeError } from "../src/protocol.ts";
import { packageFiles, packagePath } from "./build.ts";
import { verifyOmpLoader } from "./verify-omp.ts";
import { resolveTernExecutable } from "../src/tern-executable.ts";
import { resolveTernPaneSocket } from "../src/tern-routing.ts";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const PLUGIN_ID = "omp-client-bridge";
const LOADER_MARKER = "// Installed by tern-omp-bridge install-omp; SPDX-License-Identifier: MPL-2.0";
const PluginManifestSchema = z.object({
	schema: z.literal(1), id: z.literal(PLUGIN_ID), name: z.string().min(1).max(64),
	version: z.string(), description: z.string().optional(),
	window: z.string(), styles: z.array(z.string()).default([]),
	host: z.string().optional(),
	blocks: z.array(z.object({ id: z.string(), title: z.string(), icon: z.string().optional(), palette: z.boolean().optional(), files: z.array(z.string()).optional() }).strict()).optional(),
}).strict();
const PluginConfigSchema = z.record(z.string(), z.unknown());

async function readOptional(file: string): Promise<string | undefined> {
	try {
		const info = await lstat(file);
		if (!info.isFile() || info.isSymbolicLink()) throw new BridgeError("INSTALL_CONFLICT", "Refusing to replace a non-regular installation file");
		return await readFile(file, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

async function ensureDirectory(directory: string): Promise<void> {
	try {
		const info = await lstat(directory);
		if (!info.isDirectory() || info.isSymbolicLink()) throw new BridgeError("INSTALL_CONFLICT", "Installation directories must be real directories, not links or files");
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		await mkdir(directory, { recursive: true });
	}
}

/** Atomic replacement of a known plugin-owned file, leaving neighboring files alone. */
async function replaceFile(file: string, contents: string | Uint8Array): Promise<void> {
	const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
	try {
		await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
		await rename(temporary, file);
	} finally { await rm(temporary, { force: true }); }
}

/** Keep package sources inside OMP's graph rewrite so SDK imports use the host registry. */
export function ompLoaderSource(loader: string, entrypoint: string, stateDir?: string, paths: typeof path = path): string {
	const broker = paths.join(paths.dirname(paths.dirname(entrypoint)), "broker-client.ts");
	const relative = paths.relative(paths.dirname(loader), entrypoint);
	if (!paths.isAbsolute(relative)) {
		const specifier = (file: string) => JSON.stringify(`./${paths.relative(paths.dirname(loader), file).split(paths.sep).join("/")}`);
		const body = stateDir === undefined ? `export { default } from ${specifier(entrypoint)};\n` :
			`import { installClientBridge } from ${specifier(entrypoint)};\nimport { BrokerClient } from ${specifier(broker)};\nexport default (api: Parameters<typeof installClientBridge>[0]) => installClientBridge(api, new BrokerClient({ stateDir: ${JSON.stringify(stateDir)} }));\n`;
		return `${LOADER_MARKER}\n${body}`;
	}
	// Different Windows volumes cannot form a relative module specifier. This exported
	// host loader installs the same graph hooks as native extension discovery; a plain
	// dynamic import/file URL would bypass those hooks and load a second Settings scope.
	return `${LOADER_MARKER}\nimport { loadLegacyPiModule } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat";\nimport type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";\nexport default async (api: ExtensionAPI) => {\n const extension = await loadLegacyPiModule(${JSON.stringify(entrypoint)}) as typeof import(${JSON.stringify(entrypoint.split(paths.sep).join("/"))});\n${stateDir === undefined ? " return extension.default(api);" : ` const broker = await loadLegacyPiModule(${JSON.stringify(broker)}) as typeof import(${JSON.stringify(broker.split(paths.sep).join("/"))});\n return extension.installClientBridge(api, new broker.BrokerClient({ stateDir: ${JSON.stringify(stateDir)} }));`}\n};\n`;
}

export async function installOmp(target?: string, options: { stateDir?: string; hostCommand?: readonly string[] } = {}): Promise<{ kind: "omp-installed"; loader: string; entrypoint: string }> {
	const entrypoint = path.join(packageRoot, "src", "omp", "extension.ts");
	const entry = await lstat(entrypoint);
	if (!entry.isFile()) throw new BridgeError("PACKAGE_INCOMPLETE", "The native OMP extension is missing from this package");
	const agentDirectory = path.resolve(target ?? getAgentDir());
	const extensions = path.join(agentDirectory, "extensions");
	const directory = path.join(extensions, "tern-omp-client-bridge");
	await ensureDirectory(agentDirectory);
	await ensureDirectory(extensions);
	await ensureDirectory(directory);
	const loader = path.join(directory, "index.ts");
	const existing = await readOptional(loader);
	if (existing !== undefined && !existing.startsWith(LOADER_MARKER + "\n")) throw new BridgeError("INSTALL_CONFLICT", "An unrelated OMP extension already occupies the installation path");
	if (existing === undefined && (await readdir(directory)).length > 0) throw new BridgeError("INSTALL_CONFLICT", "An existing OMP extension directory cannot be adopted without its bridge loader");
	if (await readOptional(path.join(directory, "package.json")) !== undefined) throw new BridgeError("INSTALL_CONFLICT", "An extension manifest would override native index.ts discovery; refusing to alter it");
	// OMP imports canonical paths. In particular, macOS /var is /private/var;
	// relative specifiers must be computed from that same physical directory.
	const canonicalLoader = path.join(await realpath(directory), "index.ts");
	const canonicalEntrypoint = await realpath(entrypoint);
	const source = ompLoaderSource(canonicalLoader, canonicalEntrypoint, options.stateDir === undefined ? undefined : path.resolve(options.stateDir));
	// Candidate shares the final loader's directory, so relative imports are verified
	// exactly as installed. It is never published as index.ts until the host accepts it.
	const candidate = path.join(directory, `.index-probe-${crypto.randomUUID()}.ts`);
	try {
		await writeFile(candidate, source, { mode: 0o600, flag: "wx" });
		await verifyOmpLoader(candidate, options.hostCommand);
		await replaceFile(loader, source);
	} finally { await rm(candidate, { force: true }); }
	return { kind: "omp-installed", loader, entrypoint };
}

export function ternDirectories(target?: string): { config: string; state: string } {
	const override = target ?? process.env.TERN_CONFIG_DIR;
	if (override) return { config: path.resolve(override), state: path.resolve(override) };
	if (process.platform === "darwin") {
		const directory = path.join(os.homedir(), "Library", "Application Support", "Tern");
		return { config: directory, state: directory };
	}
	if (process.platform === "win32") {
		if (!process.env.APPDATA || !process.env.LOCALAPPDATA) throw new BridgeError("INSTALL_PATH", "APPDATA and LOCALAPPDATA are required, or pass --target");
		return { config: path.join(process.env.APPDATA, "Tern"), state: path.join(process.env.LOCALAPPDATA, "Tern") };
	}
	return {
		config: path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "tern"),
		state: path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"), "tern"),
	};
}

export async function installTern(options: { target?: string; controlFile?: string; ternExecutable?: string; ternPaneSocket?: string } = {}): Promise<{
	kind: "tern-installed"; plugin: string; config: string; controlFile: string; ternExecutable: string; ternPaneSocket?: string;
}> {
	const source = packageRoot;
	const manifestText = await readFile(path.join(source, "plugin.toml"), "utf8");
	const manifest = PluginManifestSchema.parse(Bun.TOML.parse(manifestText));
	const files = await packageFiles(source);
	for (const file of [manifest.window, ...(manifest.host ? [manifest.host] : []), ...manifest.styles]) {
		packagePath(file);
		if (!files.includes(file)) throw new BridgeError("PACKAGE_INCOMPLETE", "A Tern plugin entry is missing from the payload");
	}
	const roots = ternDirectories(options.target);
	const plugins = path.join(roots.config, "plugins");
	const plugin = path.join(plugins, PLUGIN_ID);
	const dataRoot = path.join(roots.state, "plugin-data");
	const data = path.join(dataRoot, PLUGIN_ID);
	const config = path.join(data, "config.json");
	const controlFile = path.resolve(options.controlFile ?? path.join(defaultStateDir(), "client.json"));
	for (const directory of [roots.config, roots.state, plugins, dataRoot, data]) await ensureDirectory(directory);
	if (await readOptional(path.join(plugins, `${PLUGIN_ID}.path`)) !== undefined) throw new BridgeError("INSTALL_CONFLICT", "This Tern plugin is already linked; remove its link explicitly before installing a copy");
	const saved = await readOptional(config);
	const previous = saved === undefined ? {} : PluginConfigSchema.parse(JSON.parse(saved));
	const ternExecutable = await resolveTernExecutable({ explicit: options.ternExecutable, saved: previous.ternExecutable });
	const ternPaneSocket = await resolveTernPaneSocket({ explicit: options.ternPaneSocket, saved: previous.ternPaneSocket, configDirectory: roots.config, isolated: options.target !== undefined });
	const installedManifest = await readOptional(path.join(plugin, "plugin.toml"));
	const previousManifest = installedManifest === undefined ? undefined : PluginManifestSchema.parse(Bun.TOML.parse(installedManifest));
	await ensureDirectory(plugin);
	const inventoryFile = path.join(plugin, ".bridge-installed-files.json");
	const inventoryText = await readOptional(inventoryFile);
	const previousFiles = previousManifest ? ["plugin.toml", previousManifest.window, ...(previousManifest.host ? [previousManifest.host] : []), ...previousManifest.styles] : [];
	if (inventoryText !== undefined) {
		if (!previousManifest) throw new BridgeError("INSTALL_CONFLICT", "An unrelated installation inventory occupies the plugin path");
		const inventory = z.object({ schema: z.literal(1), id: z.literal(PLUGIN_ID), files: z.array(z.string()) }).strict().parse(JSON.parse(inventoryText));
		for (const file of inventory.files) { packagePath(file); previousFiles.push(file); }
	}
	const ownedFiles = new Set(previousFiles);
	const journalFile = path.join(plugin, ".bridge-install-journal.json");
	const journalText = await readOptional(journalFile);
	const digestSchema = z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/));
	const pending = journalText === undefined ? undefined : z.object({ schema: z.literal(1), id: z.literal(PLUGIN_ID), files: digestSchema, retired: digestSchema }).strict().parse(JSON.parse(journalText));
	async function destination(file: string): Promise<string> {
		packagePath(file);
		let parent = plugin;
		for (const part of file.split(/[\\/]/).slice(0, -1)) { parent = path.join(parent, part); await ensureDirectory(parent); }
		return path.join(plugin, file);
	}
	// A durable intent journal distinguishes an interrupted atomic file write from
	// an unrelated collision. Only byte-identical journaled files can be adopted.
	for (const [file, digest] of Object.entries(pending?.files ?? {})) {
		const target = await destination(file);
		if (await readOptional(target) === undefined) continue;
		if (!ownedFiles.has(file) && createHash("sha256").update(await readFile(target)).digest("hex") !== digest) throw new BridgeError("INSTALL_CONFLICT", "A partially installed payload file was changed outside the installer");
		ownedFiles.add(file);
	}
	const retired = new Map<string, string>(Object.entries(pending?.retired ?? {}).filter(([file]) => !files.includes(file)));
	for (const [file, digest] of retired) {
		const target = await destination(file);
		if (await readOptional(target) !== undefined && createHash("sha256").update(await readFile(target)).digest("hex") !== digest) throw new BridgeError("INSTALL_CONFLICT", "A retired plugin entry was changed during an interrupted installation");
	}
	for (const file of previousManifest ? [previousManifest.window, ...(previousManifest.host ? [previousManifest.host] : []), ...previousManifest.styles] : []) {
		if (files.includes(file) || retired.has(file)) continue;
		const target = await destination(file);
		if (await readOptional(target) !== undefined) retired.set(file, createHash("sha256").update(await readFile(target)).digest("hex"));
	}
	const payload = new Map<string, Buffer>();
	const planned = new Map<string, string>();
	// Finish collision/link preflight before journaling or changing any payload.
	for (const file of files) {
		const existing = await readOptional(await destination(file));
		if (existing !== undefined && !ownedFiles.has(file)) throw new BridgeError("INSTALL_CONFLICT", "An unrelated file occupies a newly introduced Tern plugin payload path");
		const contents = await readFile(path.join(source, file));
		payload.set(file, contents);
		planned.set(file, createHash("sha256").update(contents).digest("hex"));
	}
	await replaceFile(journalFile, JSON.stringify({ schema: 1, id: PLUGIN_ID, files: Object.fromEntries(planned), retired: Object.fromEntries(retired) }, null, 2) + "\n");
	for (const [file, contents] of payload) await replaceFile(await destination(file), contents);
	for (const [file, digest] of retired) {
		const oldEntry = await destination(file);
		if (await readOptional(oldEntry) === undefined) continue;
		if (createHash("sha256").update(await readFile(oldEntry)).digest("hex") !== digest) throw new BridgeError("INSTALL_CONFLICT", "A retired plugin entry changed while installation was running");
		await rm(oldEntry);
	}
	await replaceFile(inventoryFile, JSON.stringify({ schema: 1, id: PLUGIN_ID, files }, null, 2) + "\n");
	await replaceFile(config, JSON.stringify({ ...previous, controlFile, serverControlFile: path.join(path.dirname(controlFile), "server.json"), ternExecutable, ternPaneSocket }, null, 2) + "\n");
	await rm(journalFile);
	return { kind: "tern-installed", plugin, config, controlFile, ternExecutable, ternPaneSocket };
}
