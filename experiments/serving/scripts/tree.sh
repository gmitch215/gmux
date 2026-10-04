#!/usr/bin/env bash
# assembles a scratch tree the site runs from, with a staged kernel as its build/kernel, so
# `wrangler dev` and `wrangler deploy` use it and build/kernel is left alone. The terminal page is
# copied without a bootstrap image (the staged kernel's image is not the one it was taken from, so
# the machine boots).
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
rsync -a "$root/build/router" "$tree/build/"
rsync -a "$root/build/assets/_gmux/term" "$tree/build/assets/_gmux/"
echo "$tree"
