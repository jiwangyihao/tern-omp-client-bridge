// SPDX-License-Identifier: MPL-2.0
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { z } from "zod";
import { defaultStateDir } from "../src/config.ts";
import { BridgeError } from "../src/protocol.ts";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const PLUGIN_ID = "omp-client-bridge";
const LOADER_MARKER = "// Installed by tern-omp-bridge install-omp; SPDX-License-Identifier: MPL-2.0";
const PluginManifestSchema = z.object({
	schema: z.literal(1), id: z.literal(PLUGIN_ID), name: z.string().min(1).max(64),
	version: z.string(), description: z.string().optional(),
	window: z.string(), styles: z.array(z.string()),
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
async function replaceFile(file: string, contents: string): Promise<void> {
	const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
	try {
		await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
		await rename(temporary, file);
	} finally { await rm(temporary, { force: true }); }
}

export async function installOmp(target?: string): Promise<{ kind: "omp-installed"; loader: string; entrypoint: string }> {
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
	// A file URL handles native Windows drive letters, spaces and Unicode without CWD assumptions.
	await replaceFile(loader, `${LOADER_MARKER}\nexport { default } from ${JSON.stringify(pathToFileURL(entrypoint).href)};\n`);
	return { kind: "omp-installed", loader, entrypoint };
}

function ternDirectories(target?: string): { config: string; state: string } {
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

export async function installTern(options: { target?: string; controlFile?: string } = {}): Promise<{
	kind: "tern-installed"; plugin: string; config: string; controlFile: string;
}> {
	const source = path.join(packageRoot, "tern");
	const manifestText = await readFile(path.join(source, "plugin.toml"), "utf8");
	const manifest = PluginManifestSchema.parse(Bun.TOML.parse(manifestText));
	const files = ["plugin.toml", manifest.window, ...manifest.styles];
	for (const file of files) {
		if (path.isAbsolute(file) || file.split(/[\\/]/).some(part => part === "..") || file.includes(":")) throw new BridgeError("INVALID_PLUGIN", "Plugin entries must remain inside their package");
		if (!(await lstat(path.join(source, file))).isFile()) throw new BridgeError("PACKAGE_INCOMPLETE", "A Tern plugin entry is missing");
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
	const installedManifest = await readOptional(path.join(plugin, "plugin.toml"));
	if (installedManifest !== undefined) PluginManifestSchema.parse(Bun.TOML.parse(installedManifest));
	await ensureDirectory(plugin);
	// Refuse collisions without a matching package identity; preserve all unrelated files.
	for (const file of files) {
		const existing = await readOptional(path.join(plugin, file));
		if (existing !== undefined && installedManifest === undefined) throw new BridgeError("INSTALL_CONFLICT", "An unrelated file occupies the Tern plugin installation path");
	}
	for (const file of files) {
		const destination = path.join(plugin, file);
		await ensureDirectory(path.dirname(destination));
		await replaceFile(destination, await readFile(path.join(source, file), "utf8"));
	}
	await replaceFile(config, JSON.stringify({ ...previous, controlFile }, null, 2) + "\n");
	return { kind: "tern-installed", plugin, config, controlFile };
}
