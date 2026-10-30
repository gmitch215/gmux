#!/bin/sh
# builds gobench for linux/amd64, linux/arm64 and wasip1/wasm into $OUT (default ./out)
# GO is the go binary (default: go on PATH)
set -e
here=$(cd "$(dirname "$0")" && pwd)
GO=${GO:-go}
OUT=${OUT:-$PWD/out}
mkdir -p "$OUT"
cd "$here/../src/gobench"
export CGO_ENABLED=0
GOOS=linux GOARCH=amd64 "$GO" build -trimpath -o "$OUT/gobench-amd64" .
GOOS=linux GOARCH=arm64 "$GO" build -trimpath -o "$OUT/gobench-arm64" .
GOOS=wasip1 GOARCH=wasm "$GO" build -trimpath -o "$OUT/gobench-wasip1.wasm" .
ls -l "$OUT"
