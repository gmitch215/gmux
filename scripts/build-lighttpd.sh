#!/usr/bin/env bash
# builds lighttpd (the pin in src/programs.json) as a wasm program: static, mod_staticfile and
# mod_dirlisting only, through scripts/cc-strict so it carries the stack ABI word. build-linux.sh calls
# it after the toolchain and musl are built; run alone it needs only a built toolchain.
# usage: scripts/build-lighttpd.sh <work dir> <output file>
# env: LW=<linux-wasm dir, default <work>/linux-wasm> REPO=<copy of scripts/ and src/, default
# <work>/repo> IMAGE=<docker image with cmake and make, default gmux-lw-base>
set -euo pipefail
work=${1:?usage: scripts/build-lighttpd.sh <work dir> <output file>}
out=${2:?usage: scripts/build-lighttpd.sh <work dir> <output file>}
root=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$work" "$(dirname "$out")"
work=$(cd "$work" && pwd)
out=$(cd "$(dirname "$out")" && pwd)/$(basename "$out")
lw=${LW:-$work/linux-wasm}
repo=${REPO:-$work/repo}
pin() { "$root/scripts/ts" "$root/scripts/pin.ts" lighttpd "$1"; }
tarball=$work/lighttpd.tar.gz
[ -f "$tarball" ] || curl -fsSL --retry 3 -o "$tarball" "$(pin url)"
echo "$(pin sha256)  $tarball" | sha256sum -c - > /dev/null
build=$work/lighttpd-build
mkdir -p "$build"
image=${IMAGE:-gmux-lw-base:$("$root/scripts/ts" "$root/scripts/pin.ts" linux-wasm commit | cut -c1-7)}
cpus=${CPUS:-8}
llvm=()
[ -n "${LLVM:-}" ] && llvm=(-v "$LLVM:/rig/linux-wasm/workspace/install/llvm:ro")
# the same recipe as scripts/census.sh (the lighttpd line): the plugins are listed in a header the
# build reads, so only these two are linked
docker run --rm --user "$(id -u):$(id -g)" --memory "${MEMORY:-8g}" --cpus "$cpus" -e HOME=/tmp \
	-v "$lw:/rig/linux-wasm:ro" -v "$repo:/rig/repo:ro" -v "$tarball:/rig/lighttpd.tar.gz:ro" -v "$build:/out" \
	"${llvm[@]}" "$image" bash -c '
set -euo pipefail
W=/rig/linux-wasm/workspace
export REAL_LLVM=$W/install/llvm/bin LINUX_WASM=/rig/linux-wasm CC=/rig/repo/scripts/cc-strict
SYSROOT=$W/install/musl-wasm32_nommu
HDRS=$W/install/busybox-kernel-headers-wasm32_nommu
T="--target=wasm-linux-musl -march=wasm32"
export CFLAGS="$T --sysroot=$SYSROOT -isystem $HDRS -D__linux__ -fPIC -O2"
export LDFLAGS="$T --sysroot=$SYSROOT -Wl,-shared -fPIC"
export AR=$LINUX_WASM/tools/fake-llvm/llvm-ar RANLIB=$LINUX_WASM/tools/fake-llvm/llvm-ranlib
export CONFIG_SITE=/rig/repo/scripts/wasm/config.site
[ -d /out/src ] || { mkdir -p /out/src && tar -xzf /rig/lighttpd.tar.gz -C /out/src; }
cd /out/src/lighttpd-*
cmake -S . -B /out/b -DCMAKE_TOOLCHAIN_FILE=/rig/repo/scripts/wasm/toolchain.cmake -DCMAKE_C_FLAGS="$CFLAGS" \
	-DCMAKE_EXE_LINKER_FLAGS="$LDFLAGS" -DBUILD_STATIC=ON -DWITH_PCRE2=OFF -DWITH_ZLIB=OFF -DWITH_BZIP=OFF \
	-DCMAKE_POLICY_VERSION_MINIMUM=3.5 > /out/configure.log 2>&1
printf "PLUGIN_INIT(mod_dirlisting)\nPLUGIN_INIT(mod_staticfile)\n" > src/plugin-static.h
make -j'"$cpus"' -C /out/b lighttpd > /out/make.log 2>&1
cp /out/b/build/lighttpd /out/lighttpd.wasm
'
cp "$build/lighttpd.wasm" "$out"
# a program built before the stack ABI word does not exec
grep -c -a 'gmux.abi' "$out" > /dev/null || {
	echo "$out carries no stack ABI word" >&2
	exit 1
}
ls -l "$out"
