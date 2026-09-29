#!/usr/bin/env bash
# katybug.wasm built the way scripts/build-linux.sh builds the shipped one (pipeline image, a finished
# run's linux-wasm tree and LLVM), once per flag set and link order (the sources rotated, as
# experiments/trace-length/scripts/sweep.sh does). Writes <out>/<name>-<layout>.raw.wasm.
# usage: build.sh <linux-wasm dir> <out dir> <name>=<flags>...   (LAYOUTS=3, CPUSET pins the build,
# SRC builds from another copy of src/gmux/katybug)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
lw=$(cd "$1" && pwd)
mkdir -p "$2"
out=$(cd "$2" && pwd)
shift 2
src=$(cd "${SRC:-$root/src/gmux/katybug}" && pwd)
layouts=${LAYOUTS:-3}
image=gmux-lw-base:$(git -C "$lw" rev-parse --short=7 HEAD 2> /dev/null || "$root/scripts/ts" "$root/scripts/pin.ts" linux-wasm commit | cut -c1-7)
W=/rig/linux-wasm/workspace
names=("$src"/*.c)
names=("${names[@]##*/}")
for spec in "$@"; do
	name=${spec%%=*}
	flags=${spec#*=}
	for ((l = 0; l < layouts; l++)); do
		s=$((l * ${#names[@]} / layouts))
		order=$(printf '/rig/src/%s ' "${names[@]:$s}" "${names[@]:0:$s}")
		docker run --rm --memory 4g --cpus "${CPUS:-2}" ${CPUSET:+--cpuset-cpus "$CPUSET"} -u "$(id -u):$(id -g)" -e HOME=/tmp \
			-v "$lw:/rig/linux-wasm:ro" -v "$root:/rig/repo:ro" -v "$src:/rig/src:ro" -v "$out:/rig/out" \
			"$image" bash -c "set -euo pipefail; cd /tmp
				LINUX_WASM=/rig/linux-wasm REAL_LLVM=$W/install/llvm/bin TMPDIR=/tmp \
				/rig/repo/scripts/cc-strict --target=wasm-linux-musl -march=wasm32 --sysroot=$W/install/musl-wasm32_nommu \
					-fPIC -O2 -Wl,-shared -D_DEFAULT_SOURCE $flags $order -o /rig/out/$name-$l.raw.wasm -lc"
		echo "$name-$l: $(wc -c < "$out/$name-$l.raw.wasm") bytes ($flags)"
	done
done
