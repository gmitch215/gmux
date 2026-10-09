#!/usr/bin/env bash
# Alpine's dynamic curl fetching a gzip body and a deflate body (--compressed) through katybug: natively, with the
# kernels off and on (zlib-curl-guest.sh), over the katybug and zbench-musl zlib-check.sh left in its rig. The three
# arms must print the same fetch lines and every body must equal the plain one; curl gives its streams its own
# allocator, so they stay the guest's (the stream kernels do not run).
# usage: zlib-curl.sh <out dir>; KATYBUG_ARCH=aarch64 for arm64 (default x86_64); NATIVE_HOST required for x86_64
# (an ssh host with docker, or local), RIG as in zlib-check.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
case ${KATYBUG_ARCH:-x86_64} in
	x86_64) platform=linux/amd64 sfx= host=${NATIVE_HOST:?set NATIVE_HOST to an ssh host with docker, or local} ;;
	aarch64) platform=linux/arm64 sfx=-aarch64 host=${NATIVE_HOST:-local} ;;
	*)
		echo "KATYBUG_ARCH: x86_64 or aarch64" >&2
		exit 2
		;;
esac
dock="docker run --rm --platform $platform --memory 2g --cpus 2"
rig=${RIG:-gmux-rig/k7z$sfx}
on_host() {
	if [ "$host" = local ]; then (cd && sh -c "$1"); else ssh "$host" "$1"; fi
}
out=${1:?usage: zlib-curl.sh <out dir>}
mkdir -p "$out"
on_host "cat > ~/$rig/t/zlib-curl-guest.sh" < "$here/zlib-curl-guest.sh"
fail=0
for arm in native off on; do
	on_host "rm -f \$HOME/$rig/t/prim.log; $dock -v \"\$HOME/$rig/t:/t\" -e KATYBUG_STATS=1 -e KATYBUG_PRIM_LOG=/t/prim.log alpine:3.20 sh /t/zlib-curl-guest.sh $arm; cat \$HOME/$rig/t/prim.log 2> /dev/null || true" > "$out/curl.$arm"
	grep '^curl ' "$out/curl.$arm" > "$out/curl.$arm.out" || true
	echo "## $arm"
	cat "$out/curl.$arm.out"
done
for arm in off on; do
	cmp -s "$out/curl.$arm.out" "$out/curl.native.out" && echo "# curl $arm == native: yes" || {
		echo "FAIL curl $arm != native"
		diff "$out/curl.native.out" "$out/curl.$arm.out" | head
		fail=1
	}
done
[ "$(grep -c 'body same' "$out/curl.native.out")" = 4 ] || {
	echo "FAIL curl: not every body equals its plain body"
	fail=1
}
grep -q 'body same encoding gzip' "$out/curl.on.out" && grep -q 'body same encoding deflate' "$out/curl.on.out" || {
	echo "FAIL curl: a --compressed fetch did not decode"
	fail=1
}
# curl sets its own zalloc and zfree on every stream, so its init is given up and the guest's libz serves the
# stream: the kernels must not have run and the init must have been given up
line=$(grep '^katybug: prim' "$out/curl.on" | grep ' inflateInit2_ 0 ([1-9]' | head -1 || true)
echo "# curl on: $(printf '%s\n' "$line" | grep -o '\(deflate\|inflate\)[A-Za-z0-9_]* [0-9]* ([0-9]* gave up)' | tr '\n' ';')"
[ -n "$line" ] || {
	echo "FAIL curl: the init of curl's stream was not given up"
	fail=1
}
if grep '^katybug: prim' "$out/curl.on" | grep -q ' inflate [1-9]'; then
	echo "FAIL curl: a stream kernel ran over curl's own allocator"
	fail=1
fi
exit $fail
