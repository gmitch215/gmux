#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/src/wasm"
wat2wasm work.wat -o work.wasm
wat2wasm shapes.wat -o shapes.wasm
