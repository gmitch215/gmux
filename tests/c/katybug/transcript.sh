#!/usr/bin/env bash
# the transcript check: unchanged static amd64 programs run every line of a command file natively on
# a Linux host (NATIVE_HOST, default paisley-park, in an Alpine container capped at 2 CPUs and 1 GB,
# work under ~/gmux-rig/) and under a native build of katybug here; each line's output and exit
# status must match. busybox/commands.txt runs against Alpine's busybox-static; userland/commands.txt
# adds coreutils, bash, sqlite3 and curl built from pinned sources by userland-build.sh.
# usage: tests/c/katybug/transcript.sh [busybox|userland]...  (default: both); KATYBUG_FORK=exec sends
# every guest fork through fork.c's exec and state transfer, as on wasm; NATIVE_HOST=local runs the
# native side on this machine, which must be Linux x86-64 with docker (CI's runner)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
host=${NATIVE_HOST:-paisley-park}
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
on_host 'docker run --rm --memory 1g --cpus 2 alpine:3.20 sh -c "apk add --no-cache busybox-static > /dev/null && cat /bin/busybox.static"' > "$out/t/busybox"
case " $suites " in *" userland "*)
	to_host "$here/userland-build.sh" gmux-rig/k3/build.sh
	# docker refuses --cpus above the host's count (a CI runner has 4)
	on_host 'c=$(nproc); [ "$c" -le 6 ] || c=6
		mkdir -p ~/gmux-rig/k3/src ~/gmux-rig/k3/out && cd ~/gmux-rig/k3 &&
		{ [ -f out/curl ] || docker run --rm --memory 4g --cpus "$c" -v "$PWD/src:/src" -v "$PWD/out:/out" \
			-v "$PWD/build.sh:/build.sh:ro" alpine:3.20 sh /build.sh > build.log 2>&1 ||
			{ tail -40 build.log >&2; false; }; } &&
		tar -C out -cf - bash coreutils curl sqlite3' | tar -C "$out/t/ubin" -xf -
	for p in $(on_host 'docker run --rm --memory 1g --cpus 2 -v "$HOME/gmux-rig/k3/out:/o:ro" alpine:3.20 /o/coreutils --help' | sed -n 's/^ \[ //p'); do
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
n=0
while IFS= read -r line; do
	n=$((n + 1))
	printf '== %s %s\n' "$n" "$line"
	env -i PATH="$path" HOME=/ LC_ALL=C TZ=UTC TMPDIR="${TMPDIR:-/tmp}" ${KATYBUG_FORK:+KATYBUG_FORK=$KATYBUG_FORK} \
		"$@" ./busybox sh -c "$line" < /dev/null 2>&1
	printf '== rc %s\n' "$?"
done < "$suite.txt"
EOF
chmod +x "$out/t/run.sh"
for s in $suites; do cp "$here/$s/commands.txt" "$out/t/$s.txt"; done

tar -C "$out" -cf - t | on_host 'mkdir -p ~/gmux-rig/t1/bbt && tar -C ~/gmux-rig/t1/bbt -xf -'
# the same tree, less its links, for transcript-gmux.ts and tests/c/run.ts's userland probe
keep=$root/build/katybug/transcript
mkdir -p "$keep/ubin"
cp "$out"/t/{busybox,run.sh} "$out"/t/*.txt "$keep/"
if [ -f "$out/t/ubin/bash" ]; then
	cp "$out"/t/ubin/{bash,coreutils,curl,sqlite3} "$keep/ubin/"
	find "$out/t/ubin" -type l -exec basename {} \; | sort > "$keep/ubin.list"
fi
fail=0
for s in $suites; do
	on_host "docker run --rm --memory 1g --cpus 2 -v \"\$HOME/gmux-rig/t1/bbt/t:/t\" alpine:3.20 /t/run.sh $s" > "$out/$s.native.txt"
	cp "$out/$s.native.txt" "$keep/"
	# the native side starts in a fresh container; a CI runner starts steps with SIGPIPE ignored
	TMPDIR=$out/tmp perl -e '$SIG{PIPE} = "DEFAULT"; exec @ARGV or die' \
		"$out/t/run.sh" "$s" "$out/katybug" > "$out/$s.katybug.txt"
	echo "# $s"
	"$root/scripts/ts" "$here/transcript-diff.ts" "$out/$s.native.txt" "$out/$s.katybug.txt" || fail=1
done
exit $fail
