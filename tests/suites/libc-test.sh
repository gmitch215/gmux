#!/usr/bin/env bash
# builds libc-test's thread, TLS, semaphore and SysV semaphore tests with cc-strict, one wasm per test;
# run inside the linux-wasm container (LINUX_WASM, REAL_LLVM set). each test exits 0 when it passes
set -euo pipefail
src=${1:?usage: tests/suites/libc-test.sh <libc-test checkout> <out dir>}
out=${2:?}
here=$(cd "$(dirname "$0")" && pwd)
W=${LINUX_WASM:-/rig/linux-wasm}/workspace/install
functional="ipc_sem pthread_cancel pthread_cancel-points pthread_cond pthread_mutex pthread_mutex_pi
	pthread_robust pthread_tsd sem_init sem_open tls_init tls_local_exec"
regression="pthread_atfork-errno-clobber pthread_cancel-sem_wait pthread_condattr_setclock
	pthread_cond-smasher pthread_cond_wait-cancel_ignored pthread_create-oom pthread_exit-cancel
	pthread_exit-dtor pthread_once-deadlock pthread-robust-detach pthread_rwlock-ebusy sem_close-unmap"
common="print rand path memfill fdfill setrlim vmfill"
mkdir -p "$out"
for kind in functional regression; do
	for t in ${!kind}; do
		"$here/../../scripts/cc-strict" --target=wasm-linux-musl -march=wasm32 --sysroot="$W/musl-wasm32_nommu" \
			-isystem "$W/busybox-kernel-headers-wasm32_nommu" -fPIC -O2 -Wl,-shared -D_GNU_SOURCE \
			-I"$src/src/common" "$src/src/$kind/$t.c" $(printf "$src/src/common/%s.c " $common) \
			-o "$out/$t.wasm" -lc 2>&1 | grep -E "error|undefined" || true
		[ -f "$out/$t.wasm" ] && echo "built $t" || echo "BUILD FAIL $t"
	done
done
