#!/usr/bin/env bash
# assembles a scratch tree the site runs from, with a staged kernel as its build/kernel, so
# `wrangler dev` and `wrangler deploy` use it and build/kernel is left alone. The staged kernel's
# bootstrap image (scripts/bootstrap.ts with GMUX_BUILD at the stage) is carried when it has one;
# a stage without one boots its machine.
# usage: scripts/tree.sh <staged build dir holding kernel/> <tree dir>
set -euo pipefail
usage='usage: scripts/tree.sh <staged build dir holding kernel/> <tree dir>'
staged=${1:?$usage}
root=$(cd "$(dirname "$0")/../../.." && pwd)
tree=${2:?$usage}
mkdir -p "$tree/build/assets/_gmux" "$tree/build/kernel"
ln -sfn "$root/node_modules" "$tree/node_modules"
rsync -a "$root/src" "$root/package.json" "$root/wrangler.jsonc" "$root/tsconfig.json" "$tree/"
rsync -a "$staged/kernel/" "$tree/build/kernel/"
# src/site-do.ts imports the asyncified lighttpd: a stage without one gets an empty module, which the site never registers
[ -f "$tree/build/kernel/lighttpd.async.wasm" ] || printf '\0asm\1\0\0\0' > "$tree/build/kernel/lighttpd.async.wasm"
if [ -d "$staged/router" ]; then rsync -a "$staged/router" "$tree/build/"; else rsync -a "$root/build/router" "$tree/build/"; fi
rsync -a "$root/build/assets/_gmux/term" "$tree/build/assets/_gmux/"
# the staged kernel's own bootstrap image, when it has one, so a deploy restores instead of booting
if [ -d "$staged/assets/_gmux/bootstrap" ]; then rsync -a "$staged/assets/_gmux/bootstrap" "$tree/build/assets/_gmux/"; fi
echo "$tree"
