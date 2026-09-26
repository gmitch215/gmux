#!/usr/bin/env bash
# regenerates syscall_adapters.c from a built kernel and says whether it changed; after a kernel
# config change, build, run this, and rebuild until it prints "fixed point"
set -euo pipefail
table=${1:?usage: scripts/kernel/adapters-check.sh <syscall_table.i> <built vmlinux.wasm> <kernel tree>}
vmlinux=${2:?}
tree=${3:?}
here=$(cd "$(dirname "$0")" && pwd)
current=$tree/arch/wasm/kernel/syscall_adapters.c
next=$(mktemp)
python3 "$here/syscall-adapters.py" "$table" "$vmlinux" "$next"
if cmp -s "$next" "$current"; then
	echo "fixed point"
else
	cp "$next" "$current"
	echo "changed: rebuild the kernel and run this again"
	exit 1
fi
