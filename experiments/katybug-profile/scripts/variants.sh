#!/usr/bin/env bash
# builds katybug.wasm once per flag set, the way scripts/build-linux.sh builds the shipped one, in the
# pipeline's image against a finished run's linux-wasm tree (tools and musl) and an LLVM install.
# usage: variants.sh <linux-wasm dir> <llvm install> <out dir> <name>=<flags>... (CPUSET pins the build)
# e.g. variants.sh ~/w/linux-wasm ~/w/linux-wasm/workspace/install/llvm out base= pc=-DKB_LEAN_PC
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
lw=$(cd "$1" && pwd)
llvm=$(cd "$2" && pwd)
mkdir -p "$3"
out=$(cd "$3" && pwd)
shift 3
image=gmux-lw-base:$(git -C "$lw" rev-parse --short=7 HEAD 2> /dev/null || "$root/scripts/ts" "$root/scripts/pin.ts" linux-wasm commit | cut -c1-7)
W=/rig/linux-wasm/workspace
for spec in "$@"; do
	name=${spec%%=*}
	flags=${spec#*=}
	docker run --rm --memory 4g --cpus "${CPUS:-4}" ${CPUSET:+--cpuset-cpus "$CPUSET"} -u "$(id -u):$(id -g)" -e HOME=/tmp \
		-v "$lw:/rig/linux-wasm:ro" -v "$llvm:$W/install/llvm:ro" -v "$root:/rig/repo:ro" -v "$out:/rig/out" \
		"$image" bash -c "set -euo pipefail; cd /tmp
			LINUX_WASM=/rig/linux-wasm REAL_LLVM=$W/install/llvm/bin TMPDIR=/tmp \
			/rig/repo/scripts/cc-strict --target=wasm-linux-musl -march=wasm32 --sysroot=$W/install/musl-wasm32_nommu \
				-fPIC -O2 -Wl,-shared -D_DEFAULT_SOURCE $flags /rig/repo/src/gmux/katybug/*.c -o /rig/out/katybug-$name.wasm -lc"
	echo "$name: $(wc -c < "$out/katybug-$name.wasm") bytes ($flags)"
done
