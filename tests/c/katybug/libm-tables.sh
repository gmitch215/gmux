#!/usr/bin/env bash
# writes libm-tables.txt: a hash of every table of exp, log and pow (libm-tables.c) as glibc 2.36, glibc
# 2.39 and musl 1.2.5 define them and as src/gmux/katybug/libm-data.c does. The sources are not kept in
# the repository, so run.sh checks the kernel's own line against this file instead of fetching them.
# usage: tests/c/katybug/libm-tables.sh <glibc 2.36 sysdeps/ieee754/dbl-64> <glibc 2.39 ...> <musl 1.2.5 root>
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
g236=${1:?usage: libm-tables.sh <glibc 2.36 dbl-64 dir> <glibc 2.39 dbl-64 dir> <musl 1.2.5 root>}
g239=${2:?}
musl=${3:?}
out=$(mktemp -d)
mkdir -p "$out/stub"
echo '#include <stdbool.h>' > "$out/stub/math_private.h"
echo '#define HIGH_ORDER_BIT_IS_SET_FOR_SNAN 0' > "$out/stub/nan-high-order-bit.h"
glibc_flags=(-D__glibc_unlikely\(x\)=x -D__glibc_likely\(x\)=x -Dattribute_hidden= -U__FP_FAST_FMA -I"$out/stub")
for v in 236 239; do
	dir=$g236
	[ $v = 239 ] && dir=$g239
	cc -std=gnu11 -w -DFROM_GLIBC "${glibc_flags[@]}" -I"$dir" -o "$out/g$v" "$here/libm-tables.c" \
		"$dir/e_exp_data.c" "$dir/e_log_data.c" "$dir/e_pow_log_data.c"
done
mkdir -p "$out/musl"
: > "$out/musl/features.h"
cc -std=gnu11 -w -DFROM_MUSL -Dhidden= -U__FP_FAST_FMA -I"$out/musl" -I"$musl/src/math" -o "$out/m" \
	"$here/libm-tables.c" "$musl/src/math/exp_data.c" "$musl/src/math/log_data.c" "$musl/src/math/pow_data.c"
cc -std=gnu11 -w -DFROM_KERNEL -o "$out/k" "$here/libm-tables.c" "$root/src/gmux/katybug/libm-data.c"
{
	echo "# table hashes (libm-tables.c): table glibc-2.36 glibc-2.39 musl-1.2.5 kernel"
	paste -d' ' <("$out/g236") <("$out/g239" | cut -d' ' -f2) <("$out/m" | cut -d' ' -f2) <("$out/k" | cut -d' ' -f2)
} > "$here/libm-tables.txt"
cat "$here/libm-tables.txt"
