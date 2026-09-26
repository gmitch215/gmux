#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/src/wasm"
wat2wasm kernel.wat -o kernel.wasm
wat2wasm process.wat -o process.wasm
wat2wasm guest.wat -o guest.bin
