#!/bin/sh
# SPDX-License-Identifier: MPL-2.0
# Invoked only inside an owned native terminal on the already connected host.
set -eu
umask 077
exec 2>/dev/null
export LC_ALL=C
nonce=invalid
complete=false
work=
lock=
child=
watch=
finish() {
  status=$?
  trap - 0
  if [ "$complete" != true ] && [ "$status" -eq 0 ]; then status=1; fi
  [ -z "$watch" ] || kill "$watch" 2>/dev/null || :
  if [ -n "$child" ]; then kill -KILL "$child" 2>/dev/null || :; wait "$child" 2>/dev/null || :; fi
  [ -z "$work" ] || rm -rf "$work"
  [ -z "$lock" ] || rmdir "$lock" 2>/dev/null || :
  if [ "$status" -ne 0 ]; then printf 'TERN_OMP_SETUP_UI_V1 ERROR %s\n' "$nonce"; fi
  exit "$status"
}
trap finish 0
trap 'exit 1' 1 2 15
[ "$#" -eq 2 ] || exit 1
case "$2" in ''|*[!A-Za-z0-9_-]*) exit 1 ;; esac
[ "${#2}" -le 64 ] || exit 1
nonce=$2
package=$1
case "$package" in /*) ;; *) exit 1 ;; esac
for tool in tern mktemp cmp; do command -v "$tool" >/dev/null || exit 1; done
work=$(mktemp -d "${TMPDIR:-/tmp}/tern-setup-ui-check.XXXXXXXX")
# Diagnostics never leave this private, short-lived directory.
ulimit -f 4096
run() {
  seconds=$1; output=$2; shift 2
  "$@" > "$output" 2>> "$work/diagnostics" < /dev/null &
  child=$!
  (
    timer=
    trap '[ -z "$timer" ] || kill "$timer" 2>/dev/null; exit 0' 1 2 15
    sleep "$seconds" & timer=$!; wait "$timer"
    kill -TERM "$child" 2>/dev/null || exit 0
    sleep 2 & timer=$!; wait "$timer"
    kill -KILL "$child" 2>/dev/null || :
  ) &
  watch=$!
  result=0
  wait "$child" || result=$?
  kill "$watch" 2>/dev/null || :
  wait "$watch" 2>/dev/null || :
  child=; watch=
  return "$result"
}
manifest='# SPDX-License-Identifier: MPL-2.0
schema = 1
id = "omp-bridge-setup"
name = "OMP Bridge Setup"
version = "0.3.0"
description = "Display-only native Bridge installation sidebar"
host = "host.luau"
styles = ["panel.css"]

[[blocks]]
id = "panel"
title = "Bridge Setup"
icon = "plug"
palette = false'
printf '%s\n' "$manifest" > "$work/manifest"
printf 'tern-omp-bridge-setup:1\n' > "$work/marker"
validate() {
  directory=$1
  [ -d "$directory" ] && [ ! -L "$directory" ] && [ -O "$directory" ] || return 1
  for entry in "$directory"/* "$directory"/.[!.]* "$directory"/..?*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    case "${entry##*/}" in plugin.toml|host.luau|view.luau|panel.css|.bridge-setup-owned) ;; *) return 1 ;; esac
    [ -f "$entry" ] && [ ! -L "$entry" ] && [ -O "$entry" ] || return 1
  done
  for file in plugin.toml host.luau view.luau panel.css .bridge-setup-owned; do
    [ -f "$directory/$file" ] && [ ! -L "$directory/$file" ] || return 1
  done
  cmp -s "$work/marker" "$directory/.bridge-setup-owned" && cmp -s "$work/manifest" "$directory/plugin.toml"
}
validate "$package"
run 15 "$work/directory" tern plugin dir
plugins=$(cat "$work/directory")
case "$plugins" in /*) ;; *) exit 1 ;; esac
case "$plugins" in /|*[[:cntrl:]]*|*/../*|*/..|*/./*|*/.|*//*) exit 1 ;; esac
# Symlinked config/plugin ancestors are not authorized replacement locations.
ancestor=$plugins
while [ "$ancestor" != / ]; do
  [ ! -L "$ancestor" ] || exit 1
  ancestor=${ancestor%/*}; [ -n "$ancestor" ] || ancestor=/
done
if [ ! -e "$plugins" ]; then mkdir -p "$plugins"; fi
[ -d "$plugins" ] && [ ! -L "$plugins" ] && [ -O "$plugins" ] || exit 1
mkdir "$plugins/.omp-bridge-setup.lock"
lock="$plugins/.omp-bridge-setup.lock"
target="$plugins/omp-bridge-setup"
[ ! -e "$target.path" ] && [ ! -L "$target.path" ] || exit 1
if [ -e "$target" ] || [ -L "$target" ]; then validate "$target"; fi
# Native install atomically replaces this verified ID and reloads its daemon.
# Any native failure, including a different plugin's reload failure, is fatal.
run 45 "$work/install" tern plugin install "$package" --force
validate "$target"
for file in plugin.toml host.luau view.luau panel.css .bridge-setup-owned; do
  cmp -s "$package/$file" "$target/$file" || exit 1
done
printf 'TERN_OMP_SETUP_UI_V1 READY %s\n' "$nonce"
complete=true
