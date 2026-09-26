#!/usr/bin/env bash
# the "binary" image content: vmlinux and busybox bytes, as a booted machine holds them
set -euo pipefail
cd "$(dirname "$0")"
cat ../boot/vendor/vmlinux.min.wasm ../boot/vendor/busybox.wasm > src/content.bin
