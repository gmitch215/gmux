#!/usr/bin/env bash
# the dynamic ELF check: every line of dynamic/commands.txt runs through the image's own /bin/sh
# in Debian (glibc) and Alpine (musl) containers, natively and under a static katybug inside the
# same container, so ld-linux, ld-musl, their shared libraries, TLS, dlopen and pthreads (threads.c)
# are the guest's own; each line's output and exit status must match. Work goes under ~/gmux-rig/ on
# the native host.
# usage: tests/c/katybug/dynamic.sh; KATYBUG_ARCH=aarch64 checks arm64 (default x86_64);
# NATIVE_HOST required for x86_64, local by default for aarch64;
# KATYBUG_FORK=exec sends every guest fork through fork.c's exec and state transfer; every other
# KATYBUG_* variable except KATYBUG_ARCH reaches the katybug runs too (values without spaces)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
case ${KATYBUG_ARCH:-x86_64} in
	x86_64) platform=linux/amd64 sfx= host=${NATIVE_HOST:?set NATIVE_HOST to an ssh host with docker, or local} ;;
	aarch64) platform=linux/arm64 sfx=-aarch64 host=${NATIVE_HOST:-local} ;;
	*)
		echo "KATYBUG_ARCH: x86_64 or aarch64" >&2
		exit 2
		;;
esac
dock="docker run --rm --platform $platform --memory 1g --cpus 2"
rig=gmux-rig/k4$sfx
on_host() {
	if [ "$host" = local ]; then (cd && sh -c "$1"); else ssh "$host" "$1"; fi
}
out=$(mktemp -d)
mkdir -p "$out/t"
cp "$here/dynamic/commands.txt" "$here/threads.c" "$out/t/"
cat > "$out/t/each.sh" << 'EOF'
#!/bin/sh
# each.sh [launcher]: every line of commands.txt through /bin/sh, with its exit status
cd /t
n=0
while IFS= read -r line; do
	n=$((n + 1))
	printf '== %s %s\n' "$n" "$line"
	env -i PATH=/usr/bin:/bin HOME=/ LC_ALL=C TZ=UTC ${1:+$(cat /t/katybug.env)} \
		$1 /bin/sh -c "$line" < /dev/null 2>&1
	printf '== rc %s\n' "$?"
done < commands.txt
EOF
env | { grep '^KATYBUG_' || true; } | { grep -v '^KATYBUG_ARCH=' || true; } > "$out/t/katybug.env"
if grep -q '[[:space:]]' "$out/t/katybug.env"; then
	echo "KATYBUG_* values must not contain spaces" >&2
	exit 2
fi
tar -C "$root/src/gmux/katybug" -cf "$out/t/src.tar" .
tar -C "$out" -cf - t | on_host "mkdir -p ~/$rig && tar -C ~/$rig -xf -"
# a static katybug, so it runs in either image, and the pthread suite against each image's libc
on_host "$dock -v \"\$HOME/$rig/t:/t\" alpine:3.20 sh -c 'apk add --no-cache build-base zlib-dev zlib-static > /dev/null &&
	mkdir -p /src && tar -C /src -xf /t/src.tar && cc -std=c11 -D_DEFAULT_SOURCE -DKB_ZLIB -O2 -static -o /t/katybug /src/*.c -lm -lz &&
	cc -O2 -pthread -o /t/threads-musl /t/threads.c'"
on_host "$dock -v \"\$HOME/$rig/t:/t\" debian:bookworm-slim sh -c 'apt-get -qq update > /dev/null &&
	apt-get -qq install -y gcc libc6-dev > /dev/null 2>&1 && gcc -O2 -pthread -o /t/threads-glibc /t/threads.c'"
fail=0
for img in debian:bookworm-slim alpine:3.20; do
	tag=${img%%:*}
	on_host "$dock -v \"\$HOME/$rig/t:/t\" $img sh /t/each.sh" > "$out/$tag.native.txt"
	on_host "$dock -v \"\$HOME/$rig/t:/t\" $img sh /t/each.sh /t/katybug" \
		> "$out/$tag.katybug.txt"
	echo "# $tag"
	"$root/scripts/ts" "$here/transcript-diff.ts" "$out/$tag.native.txt" "$out/$tag.katybug.txt" || fail=1
done
exit $fail
