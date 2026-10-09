#!/usr/bin/env bash
# builds the kernel, musl, BusyBox, the initramfs and the tests/c probes from the pins in
# src/sources.json with src/*/patches applied, into a new directory, on a linux host with docker.
# LLVM=<linux-wasm llvm install> reuses a built toolchain; otherwise it is built (about an hour).
# KERNEL_CACHE=<dir> on the same filesystem shares one kernel checkout across runs (below).
# stage the result with scripts/build-kernel.sh <dir>/out, then check it with tests/c/run.ts
set -euo pipefail
work=${1:?usage: scripts/build-linux.sh <new directory>}
root=$(cd "$(dirname "$0")/.." && pwd)
if [ -e "$work" ]; then
	echo "$work exists; the pipeline only builds into a new directory" >&2
	exit 1
fi
cpus=${CPUS:-8}
mkdir -p "$work/repo" "$work/out/probes"
work=$(cd "$work" && pwd)
# the host's TypeScript steps: bun or node, or node in docker on a host with neither
ts() {
	if command -v bun > /dev/null 2>&1 || command -v node > /dev/null 2>&1; then
		"$root/scripts/ts" "$@"
	else
		docker run --rm -u "$(id -u):$(id -g)" -v "$root:$root:ro" -v "$work:$work" node:26-bookworm-slim \
			node --no-warnings --experimental-strip-types "$@"
	fi
}
pin() { ts "$root/scripts/pin.ts" "$1" "$2"; }
# the container sees the patches, the gmux runtime, cc-strict and the probes through /rig/repo
cp -R "$root/scripts" "$root/src" "$root/tests" "$work/repo/"

lw=$work/linux-wasm
git clone -q "$(pin linux-wasm repo)" "$lw"
git -C "$lw" checkout -q "$(pin linux-wasm commit)"
retry() { "$@" || "$@" || "$@"; }
src=$lw/workspace/src
# the kernel at exactly its pin; linux-wasm's --shallow-exclude clone of the branch fails on GitHub at times
fetch_kernel() {
	git init -q "$1"
	retry git -C "$1" fetch -q --depth 1 "$(pin linux repo)" "$(pin linux commit)"
	git -C "$1" checkout -q FETCH_HEAD
}
# KERNEL_CACHE=<dir> keeps one pristine checkout per pin (2 GB) and gives each run a hardlinked copy:
# git apply replaces the files it patches, the build writes under O=, and the end checks the
# checkout is still clean
pristine=
if [ -n "${KERNEL_CACHE:-}" ]; then
	pristine=$KERNEL_CACHE/linux-$(pin linux commit)
	if [ ! -d "$pristine/.git" ]; then
		fetch_kernel "$pristine.part"
		mv "$pristine.part" "$pristine"
	fi
	mkdir -p "$src"
	cp -al "$pristine" "$src/kernel"
else
	fetch_kernel "$src/kernel"
fi
epoch=${SOURCE_DATE_EPOCH:-$(git -C "$src/kernel" log -1 --format=%ct)}
# linux-wasm's fetch commits its musl and BusyBox patches with git am, and musl's version string is
# git describe of that commit, so its committer and date are pinned too
export GIT_COMMITTER_NAME=${GIT_COMMITTER_NAME:-gmux} GIT_COMMITTER_EMAIL=${GIT_COMMITTER_EMAIL:-gmux@localhost}
export GIT_COMMITTER_DATE=${GIT_COMMITTER_DATE:-"$epoch +0000"}
# linux-wasm.sh takes one target per call
for t in fetch-musl fetch-busybox; do "$lw/linux-wasm.sh" $t >> "$work/out/fetch.log" 2>&1; done
for t in musl:musl busybox:busybox; do
	# linux-wasm's fetch applies one upstream patch as a commit on top of the pinned release
	base=$(git -C "$src/${t%%:*}" rev-parse HEAD~1)
	if [ "$base" != "$(pin "${t#*:}" commit)" ]; then
		echo "${t%%:*} is at $base, not the pinned $(pin "${t#*:}" commit)" >&2
		exit 1
	fi
done
shopt -s nullglob
for t in kernel musl busybox; do
	patches=("$root"/src/$t/patches/*.patch)
	if [ ${#patches[@]} -gt 0 ]; then
		git -C "$src/$t" apply "${patches[@]}"
	fi
done

# the build identity is fixed so two builds match; pass KBUILD_BUILD_*, SOURCE_DATE_EPOCH or
# GIT_COMMITTER_* to override
identity=(
	-e "SOURCE_DATE_EPOCH=$epoch"
	-e "KBUILD_BUILD_USER=${KBUILD_BUILD_USER:-gmux}"
	-e "KBUILD_BUILD_HOST=${KBUILD_BUILD_HOST:-gmux}"
	-e "KBUILD_BUILD_VERSION=${KBUILD_BUILD_VERSION:-1}"
	-e "KBUILD_BUILD_TIMESTAMP=${KBUILD_BUILD_TIMESTAMP:-$(LC_ALL=C TZ=UTC date -u -d "@$epoch")}"
)
image=gmux-lw-base:$(pin linux-wasm commit | cut -c1-7)
docker image inspect "$image" > /dev/null 2>&1 || docker build -q -t "$image" "$lw/docker/linux-wasm-base"
llvm=()
[ -n "${LLVM:-}" ] && llvm=(-v "$LLVM:/rig/linux-wasm/workspace/install/llvm:ro")
run() {
	docker run --rm --memory "${MEMORY:-12g}" --cpus "$cpus" -v "$work:/rig" "${llvm[@]}" "${identity[@]}" \
		-e "LW_JOBS_KERNEL_COMPILE=$cpus" -e "LW_JOBS_MUSL_COMPILE=$cpus" -e "LW_JOBS_LLVM_COMPILE=$cpus" \
		"$image" bash -c "set -euo pipefail; $1" >> "$work/out/build.log" 2>&1
}
# a toolchain passed as LLVM must be built with src/llvm/patches too
if [ -z "${LLVM:-}" ]; then
	run 'cd /rig/linux-wasm && ./linux-wasm.sh fetch-llvm
		for p in /rig/repo/src/llvm/patches/*.patch; do git -C workspace/src/llvm apply "$p"; done
		./linux-wasm.sh build-llvm'
fi

W=/rig/linux-wasm/workspace
V=wasm32_nommu
for t in build-kernel build-musl build-busybox-kernel-headers; do
	run "cd /rig/linux-wasm && ./linux-wasm.sh $t"
done

# patch 0004 carries the generated adapters; a kernel that would generate different ones is stale
run "cd $W/src/kernel && make O=$W/build/kernel-$V ARCH=wasm LLVM=/rig/linux-wasm/tools/fake-llvm/ \
	REAL_LLVM=$W/install/llvm/bin/ CROSS_COMPILE=wasm32-unknown-unknown- HOSTCC=gcc \
	arch/wasm/kernel/syscall_table.i > /dev/null
	cp $W/build/kernel-$V/arch/wasm/kernel/syscall_table.i /rig/out/"
ts "$root/scripts/kernel/syscall-adapters.ts" "$work/out/syscall_table.i" \
	"$lw/workspace/install/kernel-$V/vmlinux.wasm" "$work/out/syscall_adapters.c" >> "$work/out/build.log"
if ! cmp -s "$work/out/syscall_adapters.c" "$src/kernel/arch/wasm/kernel/syscall_adapters.c"; then
	echo "the built kernel generates different syscall adapters: put $work/out/syscall_adapters.c" \
		"in patch 0004 and build again" >&2
	exit 1
fi

# BusyBox with gmux's setjmp and vfork runtime, which only its final link may see
run "RT=/rig/gmux-rt; mkdir -p \$RT $W/build/busybox-$V $W/install/busybox-$V
	SJLJ='-isystem /rig/repo/src/gmux/include -mexception-handling -mllvm -wasm-enable-sjlj'
	for f in sjlj.c sjlj-tag.S vfork.c; do
		REAL_LLVM=$W/install/llvm/bin /rig/linux-wasm/tools/fake-llvm/clang --target=wasm-linux-musl \
			-march=wasm32 -fPIC -O2 \$SJLJ --sysroot=$W/install/musl-$V -isystem $W/install/busybox-kernel-headers-$V \
			-c /rig/repo/src/gmux/\$f -o \$RT/\${f%.*}.o
	done
	REAL_LLVM=$W/install/llvm/bin /rig/linux-wasm/tools/fake-llvm/llvm-ar rcs \$RT/libgmux.a \$RT/sjlj.o \$RT/sjlj-tag.o \$RT/vfork.o
	cd $W/src/busybox
	for CMD in wasm_defconfig '-j $cpus' install; do
		REAL_LLVM=$W/install/llvm/bin make O=$W/build/busybox-$V ARCH=wasm CONFIG_PREFIX=$W/install/busybox-$V \
			CROSS_COMPILE=/rig/linux-wasm/tools/fake-llvm/ CONFIG_SYSROOT=$W/install/musl-$V \
			CONFIG_EXTRA_CFLAGS=\"--target=wasm-linux-musl -march=wasm32 -isystem '$W/install/busybox-kernel-headers-$V' -D__linux__ -fPIC \$SJLJ\" \
			CONFIG_EXTRA_LDFLAGS=\"-mwasm32 -shared -L\$RT\" CONFIG_EXTRA_LDLIBS=gmux \
			\$CMD
	done"

# the pinned zlib: its sources go into katybug (the thunks for crc32, adler32, compress2 and uncompress) and
# into the side module below
zlib=$work/zlib-$(pin zlib url | sed 's|.*/zlib-||; s|.tar.gz||')
retry curl -fsSL -o "$work/zlib.tar.gz" "$(pin zlib url)"
echo "$(pin zlib sha256)  $work/zlib.tar.gz" | sha256sum -c - > /dev/null
tar -C "$work" -xzf "$work/zlib.tar.gz"
zsrc=
for c in adler32 compress crc32 deflate infback inffast inflate inftrees trees uncompr zutil; do
	zsrc="$zsrc /rig/$(basename "$zlib")/$c.c"
done

# the initramfs from sorted entries owned by root with one timestamp, and no gzip name or time
run "out=/rig/out/initramfs.cpio
	cp /rig/linux-wasm/patches/initramfs/initramfs-base.cpio \$out
	pack() {
		find . -mindepth 1 -exec touch -h -d @$epoch {} +
		find . -mindepth 1 -print0 | LC_ALL=C sort -z |
			cpio --null --reproducible -R 0:0 -o --format=newc -A -O \$out 2> /dev/null
	}
	cd $W/install/busybox-$V && pack
	# linux-wasm's init, and the directories every Linux program may assume (mkstemp needs /tmp)
	mkdir -p /rig/rootfs/tmp /rig/rootfs/var/tmp && chmod 1777 /rig/rootfs/tmp /rig/rootfs/var/tmp
	cp /rig/linux-wasm/patches/initramfs/init /rig/rootfs/init
	# gmux's own files (src/rootfs, its init over linux-wasm's), and katybug for foreign executables
	# (binfmt_misc, see rcS)
	cp -R /rig/repo/src/rootfs/. /rig/rootfs/
	mkdir -p /rig/rootfs/bin /rig/probes-tmp
	(cd /rig/probes-tmp && LINUX_WASM=/rig/linux-wasm REAL_LLVM=$W/install/llvm/bin TMPDIR=/rig/probes-tmp \
		/rig/repo/scripts/cc-strict --target=wasm-linux-musl -march=wasm32 --sysroot=$W/install/musl-$V \
		-fPIC -O2 -Wl,-shared -D_DEFAULT_SOURCE -DKB_ZLIB -I/rig/$(basename "$zlib") /rig/repo/src/gmux/katybug/*.c \
		$zsrc -o /rig/rootfs/bin/katybug -lc)
	cd /rig/rootfs && pack
	gzip -n -9 -c \$out > \$out.gz"

# zlib as a wasm side module, for tests/c/dl.c
run "export LINUX_WASM=/rig/linux-wasm REAL_LLVM=$W/install/llvm/bin TMPDIR=/rig/probes-tmp
	mkdir -p \$TMPDIR; cd \$TMPDIR
	for c in /rig/repo/tests/c/*.c; do
		/rig/repo/scripts/cc-strict --target=wasm-linux-musl -march=wasm32 --sysroot=$W/install/musl-$V \
			-isystem $W/install/busybox-kernel-headers-$V -fPIC -O2 -Wl,-shared \$c \
			-o /rig/out/probes/\$(basename \${c%.c}).wasm -lc
	done
	mkdir -p /rig/zlib-obj
	for c in adler32 crc32 deflate inflate inftrees inffast trees zutil compress uncompr; do
		/rig/repo/scripts/cc-strict --target=wasm-linux-musl -march=wasm32 --sysroot=$W/install/musl-$V \
			-isystem $W/install/busybox-kernel-headers-$V -fPIC -O2 -c /rig/$(basename "$zlib")/\$c.c -o /rig/zlib-obj/\$c.o
	done
	# its own references bound inside it (-Bsymbolic); malloc and free come from the program
	/rig/linux-wasm/tools/fake-llvm/ld.lld -shared -Bsymbolic -o /rig/out/probes/libz.so /rig/zlib-obj/*.o
	# tests/c/control-flow.c's side module, which imports control_flow_hook from the program
	/rig/repo/scripts/cc-strict --target=wasm-linux-musl -march=wasm32 --sysroot=$W/install/musl-$V \
		-fPIC -O2 -c /rig/repo/tests/c/side/callback.c -o /rig/callback.o
	/rig/linux-wasm/tools/fake-llvm/ld.lld -shared -o /rig/out/probes/libcallback.so /rig/callback.o"

if [ -n "$pristine" ] && [ -n "$(git -C "$pristine" status --porcelain)" ]; then
	echo "the build wrote into the kernel checkout it shares with $pristine; fetch a new KERNEL_CACHE" >&2
	exit 1
fi
cp "$lw/workspace/install/kernel-$V/vmlinux.wasm" "$work/out/"
cp "$lw/workspace/install/busybox-$V/bin/busybox" "$work/out/busybox.wasm"
cp "$lw/workspace/install/musl-$V/lib/libc.a" "$work/out/"
cp "$work/rootfs/bin/katybug" "$work/out/katybug.wasm"
(cd "$work/out" && sha256sum vmlinux.wasm busybox.wasm katybug.wasm libc.a initramfs.cpio.gz probes/*.wasm probes/libz.so probes/libcallback.so > SHA256SUMS)
ts "$root/scripts/wasm/inputs.ts" "$work/repo" > "$work/out/INPUTS"
cat "$work/out/SHA256SUMS"
