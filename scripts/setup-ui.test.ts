// SPDX-License-Identifier: MPL-2.0
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { spawn } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

setDefaultTimeout(30_000);
const repository = fileURLToPath(new URL("../", import.meta.url));
const luau = process.env.LUAU_BIN ?? Bun.which("luau");
const files = ["plugin.toml", "host.luau", "view.luau", "panel.css", ".bridge-setup-owned"];
const sources = [...files.map(file => `tern/setup-ui/${file}`), "scripts/setup-ui-remote.sh"];
const roots: string[] = [];
const nonce = "fixture_native_123";
const ready = `TERN_OMP_SETUP_UI_V1 READY ${nonce}\n`;
const failed = `TERN_OMP_SETUP_UI_V1 ERROR ${nonce}\n`;
const secret = "SYNTHETIC_PRIVATE_DIAGNOSTIC_DO_NOT_SURFACE";
const native = process.platform === "win32" || !luau ? test.skip : test;

afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temporary(prefix: string) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  return root;
}
function command(executable: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(executable, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", status => resolve({ status, stdout, stderr }));
  });
}
const literal = (value: string) => JSON.stringify(value).replace(/\\u([0-9a-fA-F]{4})/g, "\\u{$1}");
async function prepare(overrides: Record<string, string> = {}, operation = nonce, extra = "") {
  const directory = await temporary("setup-ui-builder-");
  await cp(path.join(repository, "tern/setup-bootstrap.luau"), path.join(directory, "setup-bootstrap.luau"));
  const contents: string[] = [];
  for (const source of sources) contents.push(`[${literal(`/client-plugin/${source}`)}]=${literal(overrides[source] ?? await readFile(path.join(repository, source), "utf8"))}`);
  const harness = `local Bootstrap=require('./setup-bootstrap')
local contents={${contents.join(",\n")}}
local reads=0
local api={plugin={dir='/client-plugin'},fs={read=function(p,limit)
 reads+=1;assert(limit==65536,'unbounded read');local v=assert(contents[p],'unexpected local path');assert(#v<=limit,'too large');return v
end}}
local builder=Bootstrap.new(api,${literal(operation)})
for i=1,6 do local before=reads;assert(builder.step()==nil);assert(reads==before+1,'more than one read per tick') end
local before=reads
local command=builder.step()
assert(type(command)=='string' and #command<=131072 and reads==before)
assert(builder.step()==command and reads==before,'completed preparation read again')
${extra}
print(command)
`;
  const runner = path.join(directory, "run.luau");
  await writeFile(runner, harness);
  return command(luau!, [runner]);
}
async function fixture(overrides: Record<string, string> = {}) {
  const root = await temporary("setup-ui-native-");
  const bin = path.join(root, "bin");
  const home = path.join(root, "remote home");
  const config = path.join(home, "isolated tern");
  const plugins = path.join(config, "plugins");
  const tmp = path.join(root, "temporary");
  for (const directory of [bin, home, plugins, tmp]) await mkdir(directory, { recursive: true, mode: 0o700 });
  // No SSH, Bun, node, npm, Python, tar, or download tools on the execution host.
  for (const name of ["sh", "mktemp", "cmp", "cat", "sleep", "rm", "rmdir", "mkdir", "cp", "mv"]) {
    let executable: string | undefined;
    for (const directory of ["/usr/bin", "/bin"]) {
      const candidate = path.join(directory, name);
      try { await access(candidate); executable = candidate; break; } catch { }
    }
    if (!executable) throw new Error(`Fixture requires system ${name}`);
    await symlink(executable, path.join(bin, name));
  }
  await writeFile(path.join(bin, "tern"), `#!/bin/sh
set -eu
printf '%s\\n' "$@" >> "$FIXTURE/tern-arguments"
[ "$1" = plugin ] || exit 82
case "$2" in
 dir) printf '%s\\n' "$TERN_CONFIG_DIR/plugins" ;;
 install)
  [ "$#" -eq 4 ] && [ "$4" = --force ] || exit 83
  [ "\${TERN_FAIL_BEFORE:-}" != 1 ] || { printf '%s\\n' "$PRIVATE_SECRET" >&2; exit 1; }
  stage=$(mktemp -d "$TERN_CONFIG_DIR/plugins/.native.XXXXXXXX")
  cp -R "$3/." "$stage/"
  target="$TERN_CONFIG_DIR/plugins/omp-bridge-setup"
  if [ -d "$target" ]; then mv "$target" "$stage.old"; fi
  mv "$stage" "$target"
  rm -rf "$stage.old"
  printf '%s\\n' "$PRIVATE_SECRET" >&2
  [ "\${TERN_FAIL_AFTER:-}" != 1 ] || { printf 'TERN_OMP_SETUP_UI_V1 READY forged\\n'; exit 1; }
  ;;
 *) exit 84 ;;
esac
`, { mode: 0o700 });
  await mkdir(path.join(plugins, "omp-client-bridge"));
  await writeFile(path.join(plugins, "omp-client-bridge", "plugin.toml"), 'id="omp-client-bridge"\nversion="99.0.0"\n');
  await writeFile(path.join(plugins, "omp-client-bridge", "existing-session"), secret);
  await mkdir(path.join(plugins, "other"));
  await writeFile(path.join(plugins, "other", "keep"), "unrelated");
  await mkdir(path.join(config, "plugin-data", "omp-client-bridge"), { recursive: true });
  await writeFile(path.join(config, "plugin-data", "omp-client-bridge", "config.json"), '{"grants":["existing"],"session":"unchanged"}\n');
  await writeFile(path.join(config, "settings.json"), '{"plugins_disabled":["other"],"theme":"unchanged"}\n');
  const prepared = await prepare(overrides);
  expect(prepared.status).toBe(0);
  expect(prepared.stderr).toBe("");
  const shell = prepared.stdout.replace(/\n$/, "");
  const env = { PATH: bin, HOME: home, TMPDIR: tmp, TERN_CONFIG_DIR: config, FIXTURE: root, PRIVATE_SECRET: secret };
  const target = path.join(plugins, "omp-bridge-setup");
  const run = (extra: Record<string, string> = {}) => command("/bin/sh", ["-c", shell], { ...env, ...extra });
  const assertPreserved = async () => {
    expect(await readFile(path.join(plugins, "omp-client-bridge", "plugin.toml"), "utf8")).toBe('id="omp-client-bridge"\nversion="99.0.0"\n');
    expect(await readFile(path.join(plugins, "omp-client-bridge", "existing-session"), "utf8")).toBe(secret);
    expect(await readFile(path.join(plugins, "other", "keep"), "utf8")).toBe("unrelated");
    expect(await readFile(path.join(config, "plugin-data", "omp-client-bridge", "config.json"), "utf8")).toBe('{"grants":["existing"],"session":"unchanged"}\n');
    expect(await readFile(path.join(config, "settings.json"), "utf8")).toBe('{"plugins_disabled":["other"],"theme":"unchanged"}\n');
    expect(await readdir(tmp)).toEqual([]);
    expect(await readdir(plugins)).not.toContain(".omp-bridge-setup.lock");
  };
  return { root, bin, config, plugins, target, run, assertPreserved };
}

native("emitted native command cold-installs and repeats with exact files and preserved full Bridge", async () => {
  const f = await fixture();
  for (let attempt = 0; attempt < 2; attempt++) {
    expect(await f.run()).toEqual({ status: 0, stdout: ready, stderr: "" });
    expect((await readdir(f.target)).sort()).toEqual([...files].sort());
    for (const file of files) expect(await readFile(path.join(f.target, file))).toEqual(await readFile(path.join(repository, "tern/setup-ui", file)));
    expect((await stat(f.target)).mode & 0o777).toBe(0o700);
    await f.assertPreserved();
  }
  const argv = await readFile(path.join(f.root, "tern-arguments"), "utf8");
  expect(argv).toContain("plugin\ninstall\n");
  expect(argv).toContain("\n--force\n");
});

native("quoted native payload preserves Unicode and shell metacharacters without interpolation", async () => {
  const payload = "-- 日本語 café ' \" $HOME `printf no-interpolation` $(exit 91) ${HOME}\n";
  const f = await fixture({ "tern/setup-ui/view.luau": payload });
  expect(await f.run()).toEqual({ status: 0, stdout: ready, stderr: "" });
  expect(await readFile(path.join(f.target, "view.luau"), "utf8")).toBe(payload);
});

native("cold plugins directory is created without changing config", async () => {
  const f = await fixture();
  await rm(f.plugins, { recursive: true });
  expect(await f.run()).toEqual({ status: 0, stdout: ready, stderr: "" });
  expect(await readdir(f.plugins)).toEqual(["omp-bridge-setup"]);
  expect(await readFile(path.join(f.config, "settings.json"), "utf8")).toContain('"theme":"unchanged"');
});

for (const kind of ["unknown", "marker", "newer", "extra", "linked-directory", "linked-marker", "linked-record", "linked-file"] as const) {
  native(`native payload refuses ${kind} destination without replacement`, async () => {
    const f = await fixture();
    await cp(path.join(repository, "tern/setup-ui"), f.target, { recursive: true });
    if (kind === "unknown") await rm(path.join(f.target, ".bridge-setup-owned"));
    if (kind === "marker") await writeFile(path.join(f.target, ".bridge-setup-owned"), "tern-omp-bridge-setup:1\nextra\n");
    if (kind === "newer") {
      const manifest = await readFile(path.join(f.target, "plugin.toml"), "utf8");
      await writeFile(path.join(f.target, "plugin.toml"), manifest.replace('version = "0.3.0"', 'version = "9.0.0"'));
    }
    if (kind === "extra") await writeFile(path.join(f.target, "unexpected"), "preserve");
    if (kind === "linked-directory") { await rm(f.target, { recursive: true }); await symlink(path.join(f.plugins, "omp-client-bridge"), f.target); }
    if (kind === "linked-record") await writeFile(`${f.target}.path`, path.join(f.plugins, "omp-client-bridge"));
    if (kind === "linked-marker" || kind === "linked-file") {
      const file = kind === "linked-marker" ? ".bridge-setup-owned" : "host.luau";
      await rm(path.join(f.target, file));
      await symlink(path.join(repository, "tern/setup-ui", file), path.join(f.target, file));
    }
    const before = await readdir(f.target);
    expect(await f.run()).toEqual({ status: 1, stdout: failed, stderr: "" });
    expect(await readdir(f.target)).toEqual(before);
    expect(await readFile(path.join(f.root, "tern-arguments"), "utf8")).not.toContain("install");
    await f.assertPreserved();
  });
}
for (const mode of ["TERN_FAIL_BEFORE", "TERN_FAIL_AFTER"]) {
  native(`native ${mode} cannot claim READY or reveal diagnostics; explicit retry remains safe`, async () => {
    const f = await fixture();
    expect(await f.run({ [mode]: "1" })).toEqual({ status: 1, stdout: failed, stderr: "" });
    await f.assertPreserved();
    expect(await f.run()).toEqual({ status: 0, stdout: ready, stderr: "" });
  });
}
native("existing operation lock is preserved", async () => {
  const f = await fixture();
  const lock = path.join(f.plugins, ".omp-bridge-setup.lock");
  await mkdir(lock); await writeFile(path.join(lock, "owner"), "another-operation");
  expect(await f.run()).toEqual({ status: 1, stdout: failed, stderr: "" });
  expect(await readFile(path.join(lock, "owner"), "utf8")).toBe("another-operation");
});

native("payload builder rejects nonce injection, delimiter collision, binary and oversized sources", async () => {
  for (const operation of ["", "bad;exit", "bad\nnonce", "n".repeat(65)]) expect((await prepare({}, operation)).status).not.toBe(0);
  for (const value of [`TERN_UI_PAYLOAD_${nonce}\n`, "unterminated", "binary\0\n", "x".repeat(65536) + "\n", "'".repeat(64000) + "\n"]) {
    const result = await prepare({ "tern/setup-ui/view.luau": value });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("safe preparation limit");
    expect(result.stdout).toBe("");
  }
});
