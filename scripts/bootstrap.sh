#!/bin/sh
# SPDX-License-Identifier: MPL-2.0
# Only invoked after explicit setup consent. No global runtime/profile changes.
set -eu
umask 077
exec 2>/dev/null
runtime_only=false
recover=false
if [ "${1-}" = --runtime-only ] && [ "$#" -eq 2 ]; then
  runtime_only=true
  data=$2
elif [ "$#" -eq 3 ] || { [ "$#" -eq 4 ] && [ "$4" = --recover-lock ]; }; then
  root=$1
  data=$2
  host=$3
  if [ "$#" -eq 4 ]; then recover=true; fi
else
  printf '%s\n' 'Bridge setup: expected PLUGIN_ROOT DATA SSH_HOST.' >&2
  exit 1
fi
# Absolute data paths prevent option/path ambiguity and relative CWD changes.
case "$data" in /*) ;; *) exit 1 ;; esac
[ ! -L "$data" ] || exit 1
mkdir -p "$data"
chmod 700 "$data"
work=
message='Cannot prepare private runtime storage. Check plugin data permissions.'
state() {
  printf '{"schema":1,"status":"%s","stage":"runtime","message":"%s","updatedAt":%s000}\n' "$1" "$message" "$(date +%s)" > "$data/.setup-state.$$"
  mv -f "$data/.setup-state.$$" "$data/setup-state.json"
}
finish() {
  code=$?
  trap - 0
  if [ -n "$work" ]; then rm -rf "$work"; fi
  if [ "$code" -ne 0 ]; then state failed || :; printf '%s\n' "$message" >&1; fi
  exit "$code"
}
trap finish 0
trap 'exit 1' 1 2 15
state installing
[ ! -L "$data/runtime" ] || exit 1
mkdir -p "$data/runtime"
chmod 700 "$data/runtime"
supported() {
  [ -f "$1" ] && [ -x "$1" ] && [ ! -L "$1" ] || return 1
  "$1" -e 'const v=Bun.version.split(".").map(Number);process.exit(/^\d+\.\d+\.\d+$/.test(Bun.version)&&(v[0]>1||(v[0]===1&&(v[1]>4||(v[1]===4&&v[2]>=3))))?0:1)' >/dev/null 2>&1
}
bun="$data/runtime/bun"
if ! supported "$bun"; then
  candidate=$(command -v bun || :)
  # Resolve PATH symlinks through Bun itself; launchers never modify that runtime.
  if [ -n "$candidate" ] && "$candidate" -e 'process.exit(/^\d+\.\d+\.\d+$/.test(Bun.version)&&Bun.semver.satisfies(Bun.version,">=1.4.3")?0:1)' >/dev/null 2>&1; then
    bun=$("$candidate" -e 'console.log(process.execPath)')
  else
    message='A private Bun runtime is required. Install curl, unzip and a SHA-256 utility, then retry setup.'
    command -v curl >/dev/null
    command -v unzip >/dev/null
    if command -v sha256sum >/dev/null; then hash_tool=sha256sum; else command -v shasum >/dev/null; hash_tool=shasum; fi
    system=$(uname -s)
    arch=$(uname -m)
    # Digests from https://api.github.com/repos/oven-sh/bun/releases/tags/bun-v1.4.3
    # x64 baseline supports machines without AVX2; musl is selected by its loader.
    case "$system:$arch" in
      Darwin:arm64|Darwin:aarch64) asset=bun-darwin-aarch64; sha=80afd4c069b46a6fa8f3ec520bebc750a7843e4a8d5b9583d29ad436c00a3403 ;;
      Darwin:x86_64) asset=bun-darwin-x64-baseline; sha=0fde04e8b092156b97fe6432e899baf16d9ed6ce52cbb4218d2d9c07a2f827ef ;;
      Linux:aarch64|Linux:arm64)
        asset=bun-linux-aarch64; sha=efa9813da5ed72423bf847f916e8d2c47c0d776add972354026a75e10da9aa21
        if [ -f /lib/ld-musl-aarch64.so.1 ]; then asset=bun-linux-aarch64-musl; sha=8de8a0003cc2707bb555887e3d450e24e1edf3f605f491393e89ed61a8853420; fi ;;
      Linux:x86_64)
        asset=bun-linux-x64-baseline; sha=1fc2edac843102909e3a1be1d8d9802cc6071cf074e67e88231f4ffe0f8b397b
        if [ -f /lib/ld-musl-x86_64.so.1 ]; then asset=bun-linux-x64-musl-baseline; sha=4b5b0b5503f6ebf15161e8c56eb5a263134c05cd98a86dc11ee43ac5bda9862e; fi ;;
      *) message='Unsupported runtime platform. Bridge setup supports macOS and Linux on x64 or arm64, or Windows via PowerShell.'; exit 1 ;;
    esac
    work=$(mktemp -d "$data/runtime/.download.XXXXXXXX")
    message='Bun download failed. Check HTTPS access to github.com and retry setup.'
    state installing
    curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 20 --max-time 300 "https://github.com/oven-sh/bun/releases/download/bun-v1.4.3/$asset.zip" -o "$work/bun.zip"
    message='Bun checksum verification failed. No downloaded runtime was installed; retry on a trusted network.'
    if [ "$hash_tool" = sha256sum ]; then actual=$(sha256sum "$work/bun.zip"); else actual=$(shasum -a 256 "$work/bun.zip"); fi
    actual=${actual%% *}
    [ "$actual" = "$sha" ]
    message='Bun extraction failed. Check free space and unzip availability, then retry.'
    unzip -q "$work/bun.zip" "$asset/bun" -d "$work"
    chmod 700 "$work/$asset/bun"
    message='Downloaded Bun cannot run on this operating system. Check Bun platform requirements.'
    supported "$work/$asset/bun"
    [ ! -L "$data/runtime/bun" ] || exit 1
    mv -f "$work/$asset/bun" "$data/runtime/bun"
    bun="$data/runtime/bun"
    rm -rf "$work"
    work=
  fi
fi
if [ "$runtime_only" = true ]; then printf '%s\n' "$bun"; exit 0; fi
message='Cannot launch package preparation. Reinstall the complete Tern plugin and retry.'
[ -f "$root/scripts/build.ts" ]
# The dependency-free preparer owns state and private diagnostics from this point.
trap - 0 1 2 15
if [ "$recover" = true ]; then exec "$bun" "$root/scripts/build.ts" bootstrap "$root" "$data" "$host" --recover-lock; fi
exec "$bun" "$root/scripts/build.ts" bootstrap "$root" "$data" "$host"
