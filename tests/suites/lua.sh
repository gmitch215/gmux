#!/usr/bin/env bash
# Lua's test suite on native musl and on gmux from one command, file by file, with the
# comparison printed. The native side builds the same Lua source in an Alpine container on a Linux
# host with docker (NATIVE_HOST, default paisley-park; CPUs and memory capped, work under
# ~/gmux-rig/t1); the gmux side boots build/kernel in Node, one machine per file.
# usage: tests/suites/lua.sh <lua.wasm> <lua source .tgz> <lua tests .tgz>
set -euo pipefail
lua=${1:?usage: tests/suites/lua.sh <lua.wasm> <lua source .tgz> <lua tests .tgz>}
src=${2:?lua source .tgz}
tests=${3:?lua tests .tgz}
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
host=${NATIVE_HOST:-paisley-park}
out=$(mktemp -d)

tar -xzf "$tests" -C "$out"
testdir=$(dirname "$(find "$out" -name api.lua | head -1)")

ssh "$host" 'mkdir -p ~/gmux-rig/t1'
scp -q "$src" "$host:gmux-rig/t1/lua.tgz"
scp -q "$tests" "$host:gmux-rig/t1/lua-tests.tgz"
ssh "$host" 'docker pull -q alpine:3.20 > /dev/null && docker run --rm --memory 2g --cpus 4 -v "$HOME/gmux-rig/t1:/t1:ro" alpine:3.20 sh -c "
	apk add --no-cache build-base > /dev/null && mkdir -p /w && cd /w &&
	tar -xzf /t1/lua.tgz && tar -xzf /t1/lua-tests.tgz &&
	make -C \$(dirname \$(find . -name lua.c | head -1)) -j4 linux > /dev/null 2>&1 &&
	bin=\$(find /w -type f -name lua -perm -u+x | head -1) &&
	cd \$(dirname \$(find /w -name api.lua | head -1)) &&
	for f in \$(ls *.lua | sort); do
		[ \$f = all.lua ] && continue
		if \$bin -e _port=true \$f > /dev/null 2>&1; then echo PASS \$f; else echo FAIL \$f; fi
	done"' > "$out/native.txt"

node --no-warnings --experimental-strip-types "$here/lua-gmux.ts" "$lua" "$testdir" > "$out/gmux.txt"

python3 - "$out/native.txt" "$out/gmux.txt" << 'EOF'
import sys
def load(p):
    return {l.split()[1]: l.split()[0] for l in open(p) if l.split()[:1] in (['PASS'], ['FAIL'])}
native, gmux = load(sys.argv[1]), load(sys.argv[2])
files = sorted(set(native) | set(gmux))
agree = 0
print(f"{'file':<18} {'native':<7} {'gmux':<7}")
for f in files:
    n, g = native.get(f, '-'), gmux.get(f, '-')
    agree += n == g
    print(f"{f:<18} {n:<7} {g:<7}{'' if n == g else '  differs'}")
print(f"native {sum(v == 'PASS' for v in native.values())}/{len(native)}, "
      f"gmux {sum(v == 'PASS' for v in gmux.values())}/{len(gmux)}, agree on {agree}/{len(files)}")
EOF
