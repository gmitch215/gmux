#!/usr/bin/env bash
# copies burrow's interpreter into src/vendor and writes the isolated guest and the native module as data modules
# usage: BURROW_DIST=<burrow dist dir> build.sh; needs wasm-tools; deploy with wrangler from this directory
set -euo pipefail
: "${BURROW_DIST:?set BURROW_DIST to the burrow dist directory}"
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$here/src/vendor" "$here/scratch"
cp "$BURROW_DIST/interpret.js" "$BURROW_DIST/doctor.js" "$BURROW_DIST/errors.js" "$BURROW_DIST/vendor/wasm3.wasm" "$here/src/vendor/"
node --no-warnings --experimental-strip-types "$here/../scripts/tau.ts" wat "$here/scratch"
cp "$here/scratch/bare.wasm" "$here/src/iso.bin"
cp "$here/scratch/nops.wasm" "$here/src/nops.bin"
