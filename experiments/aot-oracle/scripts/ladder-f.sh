#!/usr/bin/env bash
# the ladder's native algorithm (arm F) built from the sources the amd64 binaries come from (GNU coreutils
# 9.5's factor and sha256sum, SQLite's shell): for wasm32-linux in the census image with scripts/cc-strict
# (f-<name>.wasm), and for x86-64 with the host's clang at -O2 (native-<name>).
# usage: ladder-f.sh <linux-wasm dir> <llvm install> <census src dir with coreutils.txz, sqlite.zip> <out dir>
# (CPUSET pins the container)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
lw=$(cd "$1" && pwd)
llvm=$(cd "$2" && pwd)
src=$(cd "$3" && pwd)
mkdir -p "$4"
out=$(cd "$4" && pwd)
W=/rig/linux-wasm/workspace
docker run --rm --memory 4g --cpus "${CPUS:-4}" ${CPUSET:+--cpuset-cpus "$CPUSET"} -u "$(id -u):$(id -g)" -e HOME=/tmp \
	-v "$lw:/rig/linux-wasm:ro" -v "$llvm:$W/install/llvm:ro" -v "$root:/rig/repo:ro" -v "$src:/rig/src:ro" -v "$out:/rig/out" \
	gmux-census:latest bash -c "set -euo pipefail; cd /tmp
		export REAL_LLVM=$W/install/llvm/bin LINUX_WASM=/rig/linux-wasm TMPDIR=/tmp
		T='--target=wasm-linux-musl -march=wasm32'
		S=$W/install/musl-wasm32_nommu
		export CC=/rig/repo/scripts/cc-strict AR=/rig/linux-wasm/tools/fake-llvm/llvm-ar RANLIB=/rig/linux-wasm/tools/fake-llvm/llvm-ranlib
		export CFLAGS=\"\$T --sysroot=\$S -isystem $W/install/busybox-kernel-headers-wasm32_nommu -D__linux__ -fPIC -O2\"
		export LDFLAGS=\"\$T --sysroot=\$S -Wl,-shared -fPIC\"
		export CONFIG_SITE=/rig/repo/scripts/wasm/config.site
		mkdir -p f && cd f && tar -xf /rig/src/coreutils.txz && cd coreutils-9.5
		./configure --host=wasm32-unknown-linux-musl --build=x86_64-linux-gnu --disable-shared --enable-static --disable-nls --without-openssl --enable-no-install-program=stdbuf > /rig/out/f-configure.log 2>&1
		make -j4 > /rig/out/f-make.log 2>&1
		cp src/factor /rig/out/f-factor.wasm
		cp src/sha256sum /rig/out/f-sha256.wasm
		cd /tmp/f && unzip -q /rig/src/sqlite.zip && cd sqlite-amalgamation-*
		\$CC \$CFLAGS -DSQLITE_THREADSAFE=0 -DSQLITE_OMIT_LOAD_EXTENSION shell.c sqlite3.c \$LDFLAGS -o /rig/out/f-sqlite.wasm > /rig/out/f-sqlite.log 2>&1"
ls -l "$out"/f-*.wasm
pin() { if [ -n "${CPUSET:-}" ]; then taskset -c "$CPUSET" "$@"; else "$@"; fi; }
w=$(mktemp -d /tmp/g23-f.XXXXXX)
cd "$w"
tar -xf "$src/coreutils.txz"
(cd coreutils-9.5 && CC=clang CFLAGS=-O2 pin ./configure --disable-nls --without-openssl > "$out/native-configure.log" 2>&1 \
	&& pin make -j"${JOBS:-4}" > "$out/native-make.log" 2>&1)
cp coreutils-9.5/src/factor "$out/native-factor"
cp coreutils-9.5/src/sha256sum "$out/native-sha256"
unzip -q "$src/sqlite.zip"
pin clang -O2 -DSQLITE_THREADSAFE=0 -DSQLITE_OMIT_LOAD_EXTENSION sqlite-amalgamation-*/shell.c sqlite-amalgamation-*/sqlite3.c -lm -o "$out/native-sqlite"
ls -l "$out"/native-*
