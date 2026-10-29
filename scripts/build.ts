// SPDX-License-Identifier: MPL-2.0
// This file deliberately has no package dependencies: OS launchers run it before bun install.
import { createHash } from "node:crypto";
import { chmod, cp, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
export function packagePath(entry: string): void {
	if (!entry || path.isAbsolute(entry) || entry.split(/[\\/]/).some(part => part === ".." || part === "." || !part) || entry.includes(":")) throw new Error("Invalid package payload path");
}

/** A deterministic, link-free inventory shared by distribution and finite installation. */
export async function packageFiles(directory: string): Promise<string[]> {
	const metadata = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
	if (!Array.isArray(metadata.files) || metadata.files.some((entry: unknown) => typeof entry !== "string")) throw new Error("Missing package payload inventory");
	const files = new Set<string>();
	async function visit(entry: string): Promise<void> {
		packagePath(entry);
		const info = await lstat(path.join(directory, entry));
		if (info.isSymbolicLink()) throw new Error("Package payload must not contain links");
		if (info.isDirectory()) {
			for (const child of (await readdir(path.join(directory, entry))).sort()) await visit(`${entry}/${child}`);
		} else if (info.isFile()) files.add(entry);
		else throw new Error("Package payload must contain only regular files");
	}
	for (const entry of [...metadata.files, "package.json"]) await visit(entry);
	for (const entry of ["plugin.toml", "bun.lock", "src/cli.ts", "scripts/build.ts", "scripts/bootstrap.sh", "scripts/bootstrap.ps1"]) {
		if (!files.has(entry)) throw new Error("Incomplete native plugin payload");
	}
	return [...files].sort();
}

async function realDirectory(directory: string): Promise<void> {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const info = await lstat(directory);
	if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Expected a private real directory");
}

async function atomicJson(file: string, value: unknown): Promise<void> {
	const temporary = `${file}.${crypto.randomUUID()}.tmp`;
	try {
		await writeFile(temporary, JSON.stringify(value) + "\n", { mode: 0o600, flag: "wx" });
		await rename(temporary, file);
	} finally { await rm(temporary, { force: true }); }
}

async function optionalJson(file: string): Promise<unknown> {
	try { return JSON.parse(await readFile(file, "utf8")); }
	catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined; throw error; }
}

async function fingerprint(directory: string, files: string[]): Promise<string> {
	const hash = createHash("sha256");
	for (const file of files) hash.update(file).update("\0").update(await readFile(path.join(directory, file))).update("\0");
	return hash.digest("hex");
}

class BootstrapLockError extends Error {
	constructor(readonly recoveryRequired: boolean) {
		super(recoveryRequired ? "Interrupted setup ownership cannot be verified. Confirm recovery in the native setup dialog before retrying." : "Another package setup is still running. Wait for it to finish before retrying.");
	}
}

/** Unique registrations avoid deleting a replacement lock during concurrent stale recovery. */
export async function acquireBootstrapLock(installation: string, recover: boolean = false): Promise<() => Promise<void>> {
	const directory = path.join(installation, "bootstrap.lock");
	const ownerPath = path.join(directory, `${crypto.randomUUID()}.json`);
	async function reclaim(file: string): Promise<void> {
		const info = await lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return undefined; });
		if (!info) return;
		if (!info.isFile() || info.isSymbolicLink()) throw new BootstrapLockError(true);
		const owner = await optionalJson(file).catch(() => undefined);
		const hasPid = typeof owner === "object" && owner !== null && "pid" in owner && typeof owner.pid === "number" && Number.isSafeInteger(owner.pid) && owner.pid > 0;
		const sameHost = hasPid && "hostname" in owner && owner.hostname === os.hostname();
		let dead = false;
		if (hasPid && typeof owner.pid === "number" && (sameHost || !("hostname" in owner))) {
			try { process.kill(owner.pid, 0); throw new BootstrapLockError(false); }
			catch (error) {
				if (error instanceof BootstrapLockError) throw error;
				dead = error instanceof Error && "code" in error && error.code === "ESRCH";
				if (!dead) throw new BootstrapLockError(true);
			}
		}
		if (!(sameHost && dead) && !recover) throw new BootstrapLockError(true);
		await rm(file, { force: true });
	}
	const legacy = await lstat(directory).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return undefined; });
	if (legacy && !legacy.isDirectory()) await reclaim(directory);
	await realDirectory(directory);
	await atomicJson(ownerPath, { schema: 1, pid: process.pid, hostname: os.hostname(), processStartedAt: Math.round(Date.now() - process.uptime() * 1000), observedSystemUptime: os.uptime() });
	try {
		for (const name of await readdir(directory)) {
			// Atomic-write scratch files are not registrations and cannot authorize work.
			if (name.endsWith(".tmp") || path.join(directory, name) === ownerPath) continue;
			await reclaim(path.join(directory, name));
		}
	} catch (error) { await rm(ownerPath, { force: true }); throw error; }
	return () => rm(ownerPath, { force: true });
}

async function bootstrap(source: string, data: string, host: string, recover: boolean): Promise<void> {
	let message = "Cannot prepare private package storage. Check plugin data permissions and retry.";
	let stageName = "package";
	const installation = path.join(data, "installation");
	const temporary = path.join(installation, `.package-${crypto.randomUUID()}`);
	const dependencyStage = path.join(installation, `.dependencies-${crypto.randomUUID()}`);
	let releaseLock: (() => Promise<void>) | undefined;
	let backendStarted = false;
	const progress = (status: "installing" | "failed") => atomicJson(path.join(data, "setup-state.json"), { schema: 1, status, stage: stageName, message, updatedAt: Date.now() });
	try {
		await realDirectory(data);
		await realDirectory(installation);
		message = "Cannot acquire package setup ownership. Retry setup or confirm native recovery if requested.";
		releaseLock = await acquireBootstrapLock(installation, recover);
		message = "Plugin payload is incomplete or unsafe. Reinstall the native plugin and retry.";
		await progress("installing");
		const files = await packageFiles(source);
		const sourceHash = await fingerprint(source, files);
		const dependencies = await fingerprint(source, ["package.json", "bun.lock"]);
		const runtime = `${process.platform}-${process.arch}`;
		const packages = path.join(installation, "packages");
		const dependencyRoot = path.join(installation, "dependencies");
		await realDirectory(packages);
		await realDirectory(dependencyRoot);
		const managed = path.join(packages, sourceHash);
		const dependencyPackage = path.join(dependencyRoot, `${dependencies}-${runtime}`);
		const dependencyMarker = { schema: 1, dependencies, runtime };
		const existingDependencies = await lstat(dependencyPackage).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return undefined; });
		if (!existingDependencies) {
			stageName = "dependencies";
			message = "Pinned dependency installation failed. Check registry access and free space, then retry. Private diagnostics are in bootstrap.log.";
			await progress("installing");
			await realDirectory(dependencyStage);
			for (const file of ["package.json", "bun.lock"]) await cp(path.join(source, file), path.join(dependencyStage, file), { errorOnExist: true, force: false });
			const logPath = path.join(data, "bootstrap.log");
			const logInfo = await lstat(logPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return undefined; });
			if (logInfo && (!logInfo.isFile() || logInfo.isSymbolicLink())) throw new Error("Unsafe diagnostics path");
			const log = await open(logPath, "w", 0o600);
			try {
				const install = Bun.spawn([process.execPath, "install", "--frozen-lockfile", "--ignore-scripts"], { cwd: dependencyStage, stdin: "ignore", stdout: log.fd, stderr: log.fd, env: { ...process.env, BUN_INSTALL_CACHE_DIR: path.join(installation, "cache") } });
				const timer = setTimeout(() => install.kill(), 600_000);
				try { if (await install.exited !== 0) throw new Error("Dependency installation failed"); }
				finally { clearTimeout(timer); }
			} finally { await log.close(); }
			await realDirectory(path.join(dependencyStage, "node_modules"));
			await atomicJson(path.join(dependencyStage, ".bridge-dependencies.json"), dependencyMarker);
			await rename(dependencyStage, dependencyPackage);
		}
		message = "Cached dependencies are incomplete or modified. Setup will not overwrite files used by a running bridge; restore the private dependency tree or install an updated plugin.";
		await realDirectory(dependencyPackage);
		if (JSON.stringify(await optionalJson(path.join(dependencyPackage, ".bridge-dependencies.json"))) !== JSON.stringify(dependencyMarker)) throw new Error("Unowned dependency tree");
		await realDirectory(path.join(dependencyPackage, "node_modules"));
		const metadata = JSON.parse(await readFile(path.join(source, "package.json"), "utf8"));
		for (const [name, version] of Object.entries({ ...metadata.dependencies, ...metadata.devDependencies })) {
			const installed = JSON.parse(await readFile(path.join(dependencyPackage, "node_modules", name, "package.json"), "utf8"));
			if (installed.version !== version) throw new Error("Installed dependency version mismatch");
		}
		stageName = "package";
		const marker = { schema: 1, source: sourceHash, dependencies, runtime, dependencyPackage };
		const existing = await lstat(managed).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return undefined; });
		if (existing) {
			message = "Cached source is incomplete or modified. Setup will not overwrite a running release; restore its files or install an updated plugin.";
			if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error("Unsafe release directory");
			if (JSON.stringify(await optionalJson(path.join(managed, ".bridge-installation.json"))) !== JSON.stringify(marker) || await fingerprint(managed, files) !== sourceHash) throw new Error("Invalid immutable release");
			if (await realpath(path.join(managed, "node_modules")) !== await realpath(path.join(dependencyPackage, "node_modules"))) throw new Error("Invalid dependency link");
		} else {
			message = "Cannot stage the managed package. Check free space and plugin data permissions, then retry.";
			await realDirectory(temporary);
			for (const file of files) {
				await mkdir(path.dirname(path.join(temporary, file)), { recursive: true, mode: 0o700 });
				await cp(path.join(source, file), path.join(temporary, file), { errorOnExist: true, force: false });
			}
			// Deliberately shared immutable dependencies; Windows junctions need no developer mode.
			await symlink(path.join(dependencyPackage, "node_modules"), path.join(temporary, "node_modules"), process.platform === "win32" ? "junction" : "dir");
			await atomicJson(path.join(temporary, ".bridge-installation.json"), marker);
			await rename(temporary, managed);
		}
		// Never overwrite or delete old releases: live clients can still lazily import from them.
		await atomicJson(path.join(installation, "current.json"), { schema: 1, packageRoot: managed, fingerprint: sourceHash });
		stageName = "setup";
		message = "Backend setup failed. Check the setup status, SSH trust and host access, then retry.";
		await progress("installing");
		backendStarted = true;
		const child = Bun.spawn([process.execPath, path.join(managed, "src", "cli.ts"), "setup", "--host", host, "--plugin-data", data, "--package-root", managed], { cwd: managed, stdin: "ignore", stdout: "inherit", stderr: "ignore" });
		if (await child.exited !== 0) throw new Error("Backend setup failed");
	} catch (error) {
		if (error instanceof BootstrapLockError) { message = error.message; stageName = error.recoveryRequired ? "lock_recovery_required" : "lock_busy"; }
		let reported = false;
		if (backendStarted) {
			const state = await optionalJson(path.join(data, "setup-state.json")).catch(() => undefined);
			reported = typeof state === "object" && state !== null && "status" in state && state.status === "failed";
		}
		if (!reported) await progress("failed").catch(() => undefined);
		console.error(message);
		process.exitCode = 1;
	} finally {
		await rm(temporary, { recursive: true, force: true });
		await rm(dependencyStage, { recursive: true, force: true });
		if (releaseLock) await releaseLock();
	}
}

async function build(): Promise<void> {
	const output = path.join(root, "dist");
	const stage = path.join(root, `.dist-${crypto.randomUUID()}`);
	try {
		await mkdir(stage);
		for (const file of await packageFiles(root)) {
			await mkdir(path.dirname(path.join(stage, file)), { recursive: true });
			await cp(path.join(root, file), path.join(stage, file), { errorOnExist: true, force: false });
		}
		await chmod(path.join(stage, "src/cli.ts"), 0o755);
		await chmod(path.join(stage, "scripts/bootstrap.sh"), 0o755);
		await rm(output, { recursive: true, force: true });
		await rename(stage, output);
		console.log("Built dist/ as a native Tern plugin with private-runtime bootstrap and pinned source payload.");
	} finally { await rm(stage, { recursive: true, force: true }); }
}

if (import.meta.main) {
	if (process.argv[2] === "bootstrap" && (process.argv.length === 6 || (process.argv.length === 7 && process.argv[6] === "--recover-lock"))) await bootstrap(path.resolve(process.argv[3]!), path.resolve(process.argv[4]!), process.argv[5]!, process.argv[6] === "--recover-lock");
	else if (process.argv.length === 2) await build();
	else { console.error("Invalid package preparation arguments"); process.exitCode = 1; }
}
