#!/usr/bin/env bash
# the whole hash kernel sweep: hash-run.sh (native Katybug against native coreutils) and then hash-wasm.ts (a machine
# under node); each sample takes the lock and reads quiet.sh. <out dir>/done holds both statuses when it ends
# usage: CPU=13 LOCK=/tmp/paisley-timing.lock QUIET=<quiet.sh> COREUTILS=<static x86-64 coreutils> BUNDLE=<bundle dir>
#   WASM=<katybug.wasm> INST=<its instrumented build> hash-timing.sh <out dir>
# (the variables hash-run.sh and hash-wasm.ts read pass through; LAYOUTS=1 REPS=1 BIGREPS=1 MIBS="0 1" is a smoke run)
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "${1:?usage: hash-timing.sh <out dir>}"
out=$(cd "$1" && pwd)
bash "$here/hash-run.sh" "$out/native"
native=$?
OUT="$out/v8.tsv" taskset -c "${CPU:?set CPU}" node "$here/hash-wasm.ts" > "$out/v8.log" 2>&1
v8=$?
echo "native $native v8 $v8" > "$out/done"
[ $native = 0 ] && [ $v8 = 0 ]
