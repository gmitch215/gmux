#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/src"
wat2wasm stream.wat -o stream.wasm
