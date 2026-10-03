#!/usr/bin/env bash
# the census workloads built natively from the census tarballs: static x86-64, gcc -O2, the same
# source versions the wasm builds use. one binary set is both the native arm and what Katybug runs
# usage: native.sh <census src dir> <out dir>
set -euo pipefail
src=${1:?usage: native.sh <census src dir> <out dir>}
out=${2:?}
tree=${TREE:-/tmp/energy-native-$$}
mkdir -p "$out" "$tree"
J=${J:-4}
CF="-O2 -static"

unpack() { mkdir -p "$tree/$1" && tar -xf "$src/$2" -C "$tree/$1" && cd "$tree/$1"/*/; }

(unpack bzip2 bzip2.tgz && make -j$J bzip2 CC=gcc CFLAGS="-O2 -D_FILE_OFFSET_BITS=64" LDFLAGS=-static > "$tree/bzip2.log" 2>&1 && cp bzip2 "$out/bzip2")
(unpack lua lua.tgz && cd src && make -j$J lua CC=gcc MYCFLAGS="-O2 -DLUA_USE_POSIX" MYLDFLAGS=-static > "$tree/lua.log" 2>&1 && cp lua "$out/lua")
(mkdir -p "$tree/sqlite" && cd "$tree/sqlite" && unzip -q -o "$src/sqlite.zip" && cd sqlite-amalgamation-* \
	&& gcc $CF -DSQLITE_THREADSAFE=0 -DSQLITE_OMIT_LOAD_EXTENSION shell.c sqlite3.c -o "$out/sqlite" -lm > "$tree/sqlite.log" 2>&1)
for p in "sed sed.txz sed/sed --disable-nls" "gawk gawk.txz gawk --disable-nls --disable-extensions" "gzip gzip.txz gzip"; do
	set -- $p
	name=$1 file=$2 bin=$3
	shift 3
	(unpack "$name" "$file" && ./configure CFLAGS="-O2" LDFLAGS=-static "$@" > "$tree/$name.configure.log" 2>&1 \
		&& make -j$J > "$tree/$name.log" 2>&1 && cp "$bin" "$out/$name")
done
ls -l "$out"
