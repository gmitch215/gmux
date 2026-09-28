#!/usr/bin/env bash
# GNU coreutils' test suite natively and on a deployed gmux from one command, test by test, with the
# comparison printed. Both sides run the same static x86-64 coreutils 9.5 and bash 5.2.37 (the pins
# of tests/c/katybug/userland-build.sh), the same pruned tree and the same driver
# (coreutils-build.sh, coreutils-test.sh), as root with BusyBox for everything else and no perl.
# The native side runs in linux/amd64 Alpine containers (NATIVE_HOST: an ssh host with docker, work
# under ~/gmux-rig/t3, or local, work under build/suite/native; default local). The test container
# is read-only with size-capped tmpfs for the tree and scratch, so a test that writes without bound
# stops at the cap, not at the host's disk; a remote host needs 25 GB free before anything starts.
# The gmux side deploys tests/suites/worker to the Free account (FREE_CLOUDFLARE_ACCOUNT_ID,
# FREE_CLOUDFLARE_API_TOKEN), runs the tests in machines there, deletes the Worker and checks the
# account is back on its baseline; GMUX_URL=<a deployed suite Worker> uses that one instead, NODE=1
# runs the machines in Node.
# usage: tests/suites/coreutils.sh [test...]  (default: every shell test)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
host=${NATIVE_HOST:-local}
out=$(mktemp -d)
node=(node --no-warnings --experimental-strip-types)
dock="docker run --rm --platform linux/amd64"

if [ "$host" = local ]; then
	work=$root/build/suite/native
	mkdir -p "$work"
	on_host() { (cd "$work" && sh -c "$1"); }
	put() { cp "$1" "$work/$2"; }
	get() { cp "$work/$1" "$2"; }
else
	work='$HOME/gmux-rig/t3'
	on_host() { ssh "$host" "cd ~/gmux-rig/t3 && $1"; }
	put() { scp -q "$1" "$host:gmux-rig/t3/$2"; }
	get() { scp -q "$host:gmux-rig/t3/$1" "$2"; }
	free=$(ssh "$host" "df --output=avail -BG / | tail -1 | tr -dc 0-9")
	[ "$free" -ge 25 ] || {
		echo "$host has ${free} GB free, under 25: not starting" >&2
		exit 1
	}
	ssh "$host" 'mkdir -p ~/gmux-rig/t3'
fi

# the tree and bash, built once per version of the build script (a bounded build: ~400 MB)
put "$here/coreutils-build.sh" build.sh
put "$here/coreutils-test.sh" test.sh
on_host "{ [ -f cu.tar.gz ] && cmp -s build.sh build.stamp; } || {
	$dock --memory 4g --cpus 4 -v \"$work:/t3\" alpine:3.20 sh /t3/build.sh > build.log 2>&1 &&
	cp build.sh build.stamp; }"
get cu.tar.gz "$out/cu.tar.gz"
get bash "$out/bash"
tar -xzf "$out/cu.tar.gz" -C "$out"

# native: nothing but Alpine's BusyBox, bash and the tree, which lands in a capped tmpfs
on_host "$dock --memory 2g --cpus 2 --read-only --tmpfs /cu:exec,size=64m --tmpfs /tmp:exec,size=1g \
	-v \"$work/cu.tar.gz:/cu.tar.gz:ro\" -v \"$work/bash:/bin/bash:ro\" -v \"$work/test.sh:/test.sh:ro\" \
	alpine:3.20 sh -c 'tar -xzf /cu.tar.gz -C / && sh /test.sh $*'" > "$out/native.txt"

# gmux
if [ -n "${NODE:-}" ]; then
	"${node[@]}" "$here/coreutils-gmux.ts" "$out/cu" "$out/bash" "$@" > "$out/gmux.txt"
else
	url=${GMUX_URL:-}
	if [ -z "$url" ]; then
		"${node[@]}" "$here/coreutils-gmux.ts" "$out/cu" "$out/bash" --stage "$root/build/suite/assets/initramfs.bin"
		export CLOUDFLARE_ACCOUNT_ID=${FREE_CLOUDFLARE_ACCOUNT_ID:?} CLOUDFLARE_API_TOKEN=${FREE_CLOUDFLARE_API_TOKEN:?}
		teardown() {
			(cd "$here/worker" && bunx wrangler delete --force > /dev/null 2>&1) || true
			echo "deleted at $(date +%T)"
			bun "$here/free.ts"
		}
		trap teardown EXIT
		url=$(cd "$here/worker" && bunx wrangler deploy 2>&1 | grep -o 'https://[^ ]*\.workers\.dev' | head -1)
		[ -n "$url" ] || {
			echo "deploy gave no URL" >&2
			exit 1
		}
		echo "deployed $url at $(date +%T)"
	fi
	"${node[@]}" "$here/coreutils-gmux.ts" "$out/cu" "$out/bash" --url "$url" "$@" > "$out/gmux.txt"
fi

echo "# results in $out"
"$root/scripts/ts" "$here/lua-diff.ts" "$out/native.txt" "$out/gmux.txt"
