#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/src/wasm"
wat2wasm stores.wat -o stores.wasm
