// SPDX-License-Identifier: MPL-2.0
import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
import { lstat, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { BridgeError } from "./protocol.ts";
import { privateDirectory } from "./setup-state.ts";
import { inspectSetupPackage } from "./setup-payload.ts";

export interface RemotePlatform { system: "Linux" | "Darwin"; arch: string; home: string; root: string }
const SSH_OPTIONS = ["-T", "-o", "BatchMode=yes", "-o", "ForwardAgent=no", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=15"];

export function shellArgument(value: string): string {
	if (value.includes("\0")) throw new BridgeError("USAGE", "Shell arguments cannot contain NUL bytes.");
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function validateHost(host: string): void {
	if (!host || host.length > 255 || host.startsWith("-") || /[\s\x00-\x1f\x7f]/.test(host)) throw new BridgeError("USAGE", "Provide one trusted SSH host alias, without whitespace or SSH options.");
}

export function remotePath(value: string): string {
	const normalized = path.posix.normalize(value);
	if (!value.startsWith("/") || normalized === "/" || /[\x00-\x1f\x7f]/.test(value) || value.split("/").includes("..")) throw new BridgeError("USAGE", "Remote directory overrides must be absolute POSIX paths, not /, shell expressions or parent traversals.");
	return normalized;
}

/** Finite children only; log bytes are private and capped, public failures are fixed messages. */
export async function setupCommand(executable: string, args: string[], options: { cwd?: string; input?: Uint8Array; log: string; logStdout?: boolean; timeout?: number; message: string; env?: NodeJS.ProcessEnv }): Promise<string> {
	const log = await open(options.log, "a", 0o600);
	let logged = (await log.stat()).size;
	function diagnostics(chunk: Buffer): void {
		if (logged >= 2 * 1024 * 1024) return;
		const part = chunk.subarray(0, 2 * 1024 * 1024 - logged); logged += part.length;
		try { writeSync(log.fd, part); } catch { /* The child may already have exited. */ }
	}
	const child = spawn(executable, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
	const output: Buffer[] = [];
	let bytes = 0;
	let oversized = false;
	let timedOut = false;
	let force: NodeJS.Timeout | undefined;
	const timer = setTimeout(() => { timedOut = true; child.kill(); force = setTimeout(() => child.kill("SIGKILL"), 2000); }, options.timeout ?? 45000);
	const exited = new Promise<void>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", code => code === 0 && !oversized && !timedOut ? resolve() : reject(new BridgeError("SETUP_COMMAND_FAILED", options.message)));
	});
	child.stdout.on("data", (chunk: Buffer) => {
		bytes += chunk.length;
		if (options.logStdout) diagnostics(chunk);
		if (bytes > 1024 * 1024) { oversized = true; child.kill(); } else output.push(chunk);
	});
	child.stderr.on("data", diagnostics);
	child.stdin.on("error", () => {});
	child.stdin.end(options.input);
	try { await exited; return Buffer.concat(output).toString("utf8").trim(); }
	catch { throw new BridgeError("SETUP_COMMAND_FAILED", options.message); }
	finally { clearTimeout(timer); clearTimeout(force); await log.close(); }
}

export function sshCommand(host: string, argv: string[]): string[] {
	validateHost(host);
	// SSH executes one remote command string. POSIX quoting is applied once, to every argv element.
	return [...SSH_OPTIONS, host, argv.map(shellArgument).join(" ")];
}

const DETECT_SCRIPT = `set -eu
case "\${SHELL:-/bin/sh}" in */sh|*/bash|*/dash|*/zsh|*/ksh|*/mksh) ;; *) exit 23;; esac
case "$(uname -s)" in Linux|Darwin) ;; *) exit 20;; esac
for command in sh tar mkdir chmod mv; do command -v "$command" >/dev/null || exit 21; done
test -n "$HOME" && test -d "$HOME" || exit 22
system=$(uname -s)
if test -n "\${TERN_OMP_BRIDGE_HOME:-}"; then root=$TERN_OMP_BRIDGE_HOME
elif test "$system" = Darwin; then root="$HOME/Library/Application Support/tern-omp-client-bridge"
else root="\${XDG_STATE_HOME:-$HOME/.local/state}/tern-omp-client-bridge"; fi
printf '%s\\n' "$system" "$(uname -m)" "$HOME" "$root"
`;

export async function detectRemote(host: string, log: string, override?: string): Promise<RemotePlatform> {
	await setupCommand("ssh", ["-V"], { log, message: "Install an OpenSSH client and make ssh available to Tern, then retry." });
	const output = await setupCommand("ssh", sshCommand(host, ["sh", "-c", DETECT_SCRIPT]), { log, message: "Cannot inspect this agent host. Establish trusted, passwordless SSH access first; setup requires a POSIX Linux/macOS host with sh and tar. Host-key checks were not bypassed." });
	const [system, arch, home, detectedRoot, ...rest] = output.split(/\r?\n/);
	if (rest.length || (system !== "Linux" && system !== "Darwin") || !["x86_64", "amd64", "aarch64", "arm64"].includes(arch ?? "") || !home || !detectedRoot) throw new BridgeError("UNSUPPORTED_HOST", "The SSH host must provide clean POSIX output on Linux/macOS x86-64 or ARM64. Disable shell startup banners on noninteractive commands and retry.");
	const root = remotePath(override ?? detectedRoot);
	if (root === remotePath(home)) throw new BridgeError("USAGE", "Choose a dedicated remote bridge directory, not the remote home directory itself.");
	return { system, arch: arch!, home: remotePath(home), root };
}


export async function packageArchive(packageRoot: string, data: string, log: string): Promise<{ bytes: Uint8Array; digest: string }> {
	const { files, digest } = await inspectSetupPackage(packageRoot);
	await privateDirectory(path.join(data, "staging"));
	const archive = path.join(data, "staging", `${crypto.randomUUID()}.tar`);
	try {
		// AppleDouble/xattrs are filesystem metadata, not source; POSIX receivers would materialize extra files.
		const metadataFlags = process.platform === "darwin" ? ["--no-mac-metadata", "--no-xattrs"] : [];
		await setupCommand("tar", [...metadataFlags, "-cf", archive, "-C", packageRoot, "--", ...files], { log, message: "Source staging requires tar (included with current Windows/macOS/Linux). Check the managed package and available disk space." });
		const info = await lstat(archive);
		if (info.size > 40 * 1024 * 1024) throw new BridgeError("PACKAGE_INCOMPLETE", "The source archive exceeds its staging limit.");
		return { bytes: await readFile(archive), digest };
	} finally { await rm(archive, { force: true }); }
}

const PUBLISH_SCRIPT = `import * as fs from "node:fs/promises";
import { inspectSetupPackage } from "./src/setup-payload.ts";
const [stage, target, digest, mode] = process.argv.slice(1);
if ((await inspectSetupPackage(stage)).digest !== digest) throw Error("Staged source integrity conflict");
if (mode !== "verify") {
 await fs.writeFile(stage+"/.setup-package.json",JSON.stringify({schema:1,digest}),{mode:384,flag:"wx"});
 try { await fs.rename(stage,target); }
 catch (error) {
  if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
 }
}
const marker=JSON.parse(await fs.readFile(target+"/.setup-package.json","utf8"));
if(marker.schema!==1 || marker.digest!==digest || (await inspectSetupPackage(target)).digest!==digest) throw Error("Immutable source integrity conflict; inspect the owned release before retrying, never overwrite live source");
`;

const STAGE_SCRIPT = `set -eu
umask 077
root=$1
id=$2
digest=$3
stage="$root/installation/.stage-$id"
release="$root/installation/packages/$digest"
if test -e "$root"; then test -d "$root" && test ! -L "$root" && test -O "$root" || exit 30; fi
mkdir -p "$root"
chmod 700 "$root"
for directory in "$root/installation" "$root/installation/packages"; do
 if test -e "$directory"; then test -d "$directory" && test ! -L "$directory" && test -O "$directory" || exit 31; fi
 mkdir -p "$directory"
 chmod 700 "$directory"
done
if test -e "$release"; then test -d "$release" && test ! -L "$release" && test -O "$release" || exit 33; fi
mkdir "$stage"
trap 'rm -rf "$stage"' EXIT
trap 'exit 1' HUP INT TERM
tar -xf - -C "$stage"
if ! bun=$(sh "$stage/scripts/bootstrap.sh" --runtime-only "$root"); then printf '%s\\n' "$bun" >&2; exit 32; fi
test -x "$bun" || exit 32
if test ! -f "$release/.setup-package.json"; then
 (cd "$stage" && "$bun" install --frozen-lockfile --ignore-scripts) >&2
 (cd "$stage" && "$bun" -e "$4" "$stage" "$release" "$digest")
else
 (cd "$stage" && "$bun" -e "$4" "$stage" "$release" "$digest" verify) >&2
 # Restore interrupted/missing dependencies without replacing source used by a live service.
 if ! (cd "$release" && "$bun" -e 'import "./src/cli.ts";') >&2; then
  (cd "$release" && "$bun" install --frozen-lockfile --ignore-scripts --force) >&2
 fi
fi
printf '%s\\n' "$bun" "$release"
`;

export async function stageRemote(host: string, remote: RemotePlatform, source: { bytes: Uint8Array; digest: string }, log: string): Promise<{ bun: string; packageRoot: string }> {
	const output = await setupCommand("ssh", sshCommand(host, ["sh", "-c", STAGE_SCRIPT, "bridge-stage", remote.root, crypto.randomUUID(), source.digest, PUBLISH_SCRIPT]), {
		input: source.bytes, log, timeout: 900000,
		message: "Remote package preparation failed. Inspect the private setup log for source-integrity conflicts, runtime/download/dependency failures or disk permissions. Referenced releases are never overwritten; resolve any integrity conflict explicitly before retrying.",
	});
	const [bun, packageRoot, ...rest] = output.split(/\r?\n/);
	if (!bun || !packageRoot || rest.length || remotePath(packageRoot) !== path.posix.join(remote.root, "installation", "packages", source.digest)) throw new BridgeError("REMOTE_STAGING_FAILED", "The remote installer did not return the expected private package path. Inspect its private log before retrying.");
	return { bun: remotePath(bun), packageRoot };
}
