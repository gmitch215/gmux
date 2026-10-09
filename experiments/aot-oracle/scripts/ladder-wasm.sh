#!/usr/bin/env bash
# each rung's katybug.wasm for the ladder (one per arm and workload: the arm's lifted regions built in with
# the flags ladder.sh builds it with), and the host's instrumented build of every wasm program in the
# out dir (katybug-*.wasm, f-*.wasm) as <name>.inst.wasm, in the census image (wabt, node).
# usage: ladder-wasm.sh <linux-wasm dir> <llvm install> <out dir with f-*.wasm> <dir with aot-<arm>-<workload>.c> [arms]
# (CPUSETS="0,1 2,3" runs one build stream per set, four cpus each; ID_FLAGS adds flags to arms named <..>+id<..>,
# the lifter's --identity builds, e.g. "-DKB_IDENTITY -DKB_WINDOW=16777216" for the window runtime)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
lw=$(cd "$1" && pwd)
llvm=$(cd "$2" && pwd)
mkdir -p "$3"
out=$(cd "$3" && pwd)
aot=$(cd "$4" && pwd)
arms=${5:-A B C D E}
read -ra sets <<< "${CPUSETS:-}"
[ "${#sets[@]}" -gt 0 ] || sets=("")
flags() {
	local base='-DKB_AOT -I/rig/repo/src/gmux/katybug -I/rig/repo/experiments/aot-oracle/src'
	case $1 in
		A | B | B0) echo "$base -DKB_TRACE=1 -DAOT_POLL=0" ;;
		C | C0) echo "$base -DAOT_POLL=0" ;;
		*+id*) echo "$base ${ID_FLAGS:-}" ;;
		*) echo "$base" ;;
	esac
}
specs=()
for arm in $arms; do
	for w in ${WORKLOADS:-sha256 factor sqlite}; do
		cp "$aot/aot-$arm-$w.c" "$out/aot-$arm-$w.c"
		specs+=("$arm-$w=$(flags "$arm") /rig/out/aot-$arm-$w.c")
	done
done
n=${#sets[@]}
for ((i = 0; i < n; i++)); do
	mine=()
	for ((j = i; j < ${#specs[@]}; j += n)); do mine+=("${specs[$j]}"); done
	CPUSET=${sets[$i]} CPUS=4 "$here/../../katybug-profile/scripts/variants.sh" "$lw" "$llvm" "$out" "${mine[@]}" > "$out/build-$i.log" 2>&1 &
done
wait
W=/rig/linux-wasm/workspace
instrument() {
	docker run --rm --memory 4g --cpus 2 ${1:+--cpuset-cpus "$1"} -u "$(id -u):$(id -g)" -e HOME=/tmp \
		-v "$root:/rig/repo:ro" -v "$out:/rig/out" gmux-census:latest \
		bash -c "cd /tmp && /rig/repo/scripts/wasm/instrument.sh /rig/out/$2.wasm /rig/out/$2.inst.wasm"
}
todo=()
for f in "$out"/katybug-*.wasm "$out"/f-*.wasm; do
	case $f in *.inst.wasm) continue ;; esac
	[ -e "${f%.wasm}.inst.wasm" ] || todo+=("$(basename "${f%.wasm}")")
done
for ((i = 0; i < n; i++)); do
	(
		for ((j = i; j < ${#todo[@]}; j += n)); do instrument "${sets[$i]}" "${todo[$j]}"; done
	) &
done
wait
ls -l "$out"/*.wasm
