#!/usr/bin/env bash
# on paisley-park, from the rig copy: the timed sweep. usage: CPU=14 bash timed.sh <out dir>
# time.tsv: every cell natively and in the machine, REPS rounds, the lock and quiet.sh per sample;
# profile.json: PREPS sampled passes of each machine cell, the lock per pass. <out dir>/done holds both statuses
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out=${1:?usage: timed.sh <out dir>}
mkdir -p "$out"
LOCKED=1 MODE=time REPS=${REPS:-5} bash "$here/run.sh" "$out/time.tsv" > "$out/time.log" 2>&1
t=$?
LOCKED=1 MODE=profile PREPS=${PREPS:-3} bash "$here/run.sh" "$out/profile.json" > "$out/profile.log" 2>&1
p=$?
echo "time $t profile $p" > "$out/done"
[ $t = 0 ] && [ $p = 0 ]
