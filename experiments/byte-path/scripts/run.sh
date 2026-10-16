#!/usr/bin/env bash
# on paisley-park, from the rig copy: usage MODE=time|count|profile|native CPU=<core> bash run.sh <out file>
# env passed through to split.ts: CELLS REPS PREPS ARMS; LOCK and QUIET are set when LOCKED=1
set -uo pipefail
R=$(cd "$(dirname "$0")/../../.." && pwd)
out=${1:?out file}
mkdir -p "$(dirname "$out")"
source ~/.nvm/nvm.sh > /dev/null
nvm use 26.10.0 > /dev/null
cpu=${CPU:?set CPU}
export GMUX_BUILD=$R/build-p1c BUNDLE=$R/build-p1c/kernel COREUTILS=$R/coreutils NATBB=$R/busybox-native \
	WASM=$R/katybug-host.wasm INST=$R/katybug-host.inst.wasm CLASSES=$R/classes.json OUT=$out CPU=$cpu
if [ "${LOCKED:-0}" = 1 ]; then export LOCK=/tmp/paisley-timing.lock QUIET=$R/quiet.sh; fi
taskset -c "$cpu" node --no-warnings --experimental-strip-types "$R/experiments/byte-path/scripts/split.ts"
