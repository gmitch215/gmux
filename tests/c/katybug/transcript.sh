#!/usr/bin/env bash
# the transcript check: unchanged static Linux programs run every line of a command file natively (in
# an Alpine container capped at 2 CPUs and 1 GB, work under ~/gmux-rig/) and under a native build of
# katybug here; each line's output and exit status must match. busybox/commands.txt runs against
# Alpine's busybox-static; userland/commands.txt adds coreutils, bash, sqlite3 and curl built from
# pinned sources by userland-build.sh.
# usage: tests/c/katybug/transcript.sh [busybox|userland]...  (default: both); KATYBUG_ARCH=aarch64
# checks the arm64 builds (default x86_64); NATIVE_HOST required: the host whose docker runs the native
# side; local means this machine, which must run containers of that architecture (CI's runner, or an
# arm64 Mac); KATYBUG_FORK=exec sends every guest fork through fork.c's exec and state transfer, as on wasm
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
dock="docker run --rm --platform $platform"
rig=gmux-rig/k3$sfx
on_host() {
	if [ "$host" = local ]; then (cd && sh -c "$1"); else ssh "$host" "$1"; fi
}
to_host() {
	if [ "$host" = local ]; then
		mkdir -p "$HOME/$(dirname "$2")" && cp "$1" "$HOME/$2"
	else
		scp -q "$1" "$host:$2"
	fi
}
suites=${*:-busybox userland}
out=$(mktemp -d)
cc -std=c11 -D_DEFAULT_SOURCE -D_DARWIN_C_SOURCE -O2 ${KATYBUG_CFLAGS:-} -o "$out/katybug" "$root"/src/gmux/katybug/*.c -lm

# the work tree both sides see: inputs, the binaries, bin/ and ubin/ of links, and the runner
mkdir -p "$out/t/bin" "$out/t/ubin" "$out/tmp"
cp "$here"/busybox/input.txt "$here"/busybox/numbers.txt "$out/t/"
on_host "$dock"' --memory 1g --cpus 2 alpine:3.20 sh -c "apk add --no-cache busybox-static > /dev/null && cat /bin/busybox.static"' > "$out/t/busybox"
case " $suites " in *" userland "*)
	to_host "$here/userland-build.sh" "$rig/build.sh"
	# docker refuses --cpus above the host's count (a CI runner has 4)
	on_host 'c=$(getconf _NPROCESSORS_ONLN); [ "$c" -le 6 ] || c=6
		mkdir -p ~/'"$rig"'/src ~/'"$rig"'/out && cd ~/'"$rig"' &&
		{ [ -f out/curl ] || '"$dock"' --memory 4g --cpus "$c" -v "$PWD/src:/src" -v "$PWD/out:/out" \
			-v "$PWD/build.sh:/build.sh:ro" alpine:3.20 sh /build.sh > build.log 2>&1 ||
			{ tail -40 build.log >&2; false; }; } &&
		tar -C out -cf - bash coreutils curl sqlite3' | tar -C "$out/t/ubin" -xf -
	for p in $(on_host "$dock"' --memory 1g --cpus 2 -v "$HOME/'"$rig"'/out:/o:ro" alpine:3.20 /o/coreutils --help' | sed -n 's/^ \[ //p'); do
		ln -s coreutils "$out/t/ubin/$p"
	done
	ln -s coreutils "$out/t/ubin/["
	;;
esac
chmod +x "$out/t/busybox"
cat > "$out/t/run.sh" << 'EOF'
#!/bin/sh
# run.sh <suite> <launcher...>: each line of <suite>.txt through busybox sh, with its exit status
cd "$(dirname "$0")"
suite=$1
shift
for a in $("$@" ./busybox --list); do ln -sf ../busybox "bin/$a"; done
path=$PWD/bin
[ "$suite" = userland ] && path=$PWD/ubin:$path
# under a launcher each line gets its own process group, killed after 300 s or once the line
# returns, so a hung line fails alone and leaves nothing listening for the next
limit= perl=$(command -v perl || true)
[ $# -gt 0 ] && [ -n "$perl" ] && limit='$p = fork; if (!$p) { setpgrp; exec @ARGV; exit 127 }
	$SIG{ALRM} = sub { kill "KILL", -$p; print "== timed out\n"; exit 124 }; alarm 300; waitpid $p, 0;
	$s = $?; kill "KILL", -$p; exit($s & 127 ? 128 + ($s & 127) : $s >> 8)'
n=0
while IFS= read -r line; do
	n=$((n + 1))
	printf '== %s %s\n' "$n" "$line"
	env -i PATH="$path" HOME=/ LC_ALL=C TZ=UTC TMPDIR="${TMPDIR:-/tmp}" ${KATYBUG_FORK:+KATYBUG_FORK=$KATYBUG_FORK} \
		${limit:+"$perl" -e "$limit"} "$@" ./busybox sh -c "$line" < /dev/null 2>&1
	printf '== rc %s\n' "$?"
done < "$suite.txt"
EOF
chmod +x "$out/t/run.sh"
for s in $suites; do cp "$here/$s/commands.txt" "$out/t/$s.txt"; done

tar -C "$out" -cf - t | on_host "mkdir -p ~/gmux-rig/t1/bbt$sfx && tar -C ~/gmux-rig/t1/bbt$sfx -xf -"
# the same tree, less its links, for transcript-gmux.ts and tests/c/run.ts's userland probe
keep=$root/build/katybug/transcript$sfx
mkdir -p "$keep/ubin"
cp "$out"/t/{busybox,run.sh} "$out"/t/*.txt "$keep/"
if [ -f "$out/t/ubin/bash" ]; then
	cp "$out"/t/ubin/{bash,coreutils,curl,sqlite3} "$keep/ubin/"
	find "$out/t/ubin" -type l -exec basename {} \; | sort > "$keep/ubin.list"
fi
fail=0
for s in $suites; do
	on_host "$dock --memory 1g --cpus 2 -v \"\$HOME/gmux-rig/t1/bbt$sfx/t:/t\" alpine:3.20 /t/run.sh $s" > "$out/$s.native.txt"
	cp "$out/$s.native.txt" "$keep/"
	# the native side starts in a fresh container; a CI runner starts steps with SIGPIPE ignored
	TMPDIR=$out/tmp perl -e '$SIG{PIPE} = "DEFAULT"; exec @ARGV or die' \
		"$out/t/run.sh" "$s" "$out/katybug" > "$out/$s.katybug.txt"
	echo "# $s"
	"$root/scripts/ts" "$here/transcript-diff.ts" "$out/$s.native.txt" "$out/$s.katybug.txt" || fail=1
done
exit $fail
