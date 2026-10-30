#!/usr/bin/env bash
# builds and stages the kernel at a commit that is on no remote: a merge of the fork into a newer tag, as
# scripts/kernel-bump.ts check leaves it. usage: scripts/kernel-bump-stage.sh <git dir> <commit> <out dir>
# the commit is fetched from <git dir> into the pristine checkout $KERNEL_CACHE/linux-<commit> (default
# <out dir>/cache) that scripts/build-linux.sh uses in place of a fetch, and the build runs from a copy of
# this repository in <out dir>/repo whose src/sources.json names the commit; this tree is never edited.
# the pipeline's output is <out dir>/build/out and the stage is <out dir>/repo/build/kernel.
# LLVM=<linux-wasm llvm install> is required, a linux host with docker builds, a host with wabt and a
# node_modules stages; with only one of them the script does its half and says what is left.
# BASE_REF and BASE_COMMIT replace linux.base; CPUS and MEMORY go to the pipeline; DOCKER_USER=1 runs
# its containers as the calling user, so the build tree is not root-owned
set -euo pipefail
gitdir=${1:?usage: scripts/kernel-bump-stage.sh <git dir> <commit> <out dir>}
commit=${2:?usage: scripts/kernel-bump-stage.sh <git dir> <commit> <out dir>}
out=${3:?usage: scripts/kernel-bump-stage.sh <git dir> <commit> <out dir>}
root=$(cd "$(dirname "$0")/.." && pwd)
if [[ ! $commit =~ ^[0-9a-f]{40}$ ]]; then
	commit=$(git -C "$gitdir" rev-parse --verify "$commit^{commit}")
fi
mkdir -p "$out"
out=$(cd "$out" && pwd)
repo=$out/repo
cache=${KERNEL_CACHE:-$out/cache}

old=$("$root/scripts/ts" "$root/scripts/pin.ts" linux commit)
edits=(-e "s/$old/$commit/")
if [ -n "${BASE_REF:-}" ]; then
	edits+=(-e "/\"base\": {/,/}/ s/\"ref\": \"[^\"]*\"/\"ref\": \"$BASE_REF\"/")
fi
if [ -n "${BASE_COMMIT:-}" ]; then
	edits+=(-e "/\"base\": {/,/}/ s/\"commit\": \"[0-9a-f]*\"/\"commit\": \"$BASE_COMMIT\"/")
fi
mkdir -p "$repo"
cp -R "$root/scripts" "$root/src" "$root/tests" "$root/package.json" "$repo/"
sed "${edits[@]}" "$root/src/sources.json" > "$repo/src/sources.json"
if [ "$("$repo/scripts/ts" "$repo/scripts/pin.ts" linux commit)" != "$commit" ]; then
	echo "src/sources.json in $repo does not pin $commit" >&2
	exit 1
fi
[ -d "$root/node_modules" ] && ln -sfn "$root/node_modules" "$repo/node_modules"

if [ ! -s "$out/build/out/vmlinux.wasm" ]; then
	: "${LLVM:?LLVM=<linux-wasm llvm install> is needed to build}"
	pristine=$cache/linux-$commit
	if [ ! -d "$pristine/.git" ]; then
		mkdir -p "$cache"
		git init -q "$pristine.part"
		git -C "$pristine.part" fetch -q --depth 1 "$gitdir" "$commit"
		git -C "$pristine.part" checkout -q FETCH_HEAD
		mv "$pristine.part" "$pristine"
	fi
	if [ -n "${DOCKER_USER:-}" ]; then
		mkdir -p "$out/shim"
		real=$(command -v docker)
		{
			echo '#!/bin/sh'
			echo "mkdir -p $out/build/linux-wasm/workspace/install"
			echo "[ \"\$1\" = run ] && { shift; exec $real run --user $(id -u):$(id -g) -e HOME=/tmp \"\$@\"; }"
			echo "exec $real \"\$@\""
		} > "$out/shim/docker"
		chmod +x "$out/shim/docker"
		export PATH="$out/shim:$PATH"
	fi
	env CPUS="${CPUS:-8}" LLVM="$LLVM" KERNEL_CACHE="$cache" "$repo/scripts/build-linux.sh" "$out/build"
fi

for tool in wasm2wat wat2wasm; do
	if ! command -v "$tool" > /dev/null 2>&1; then
		echo "$tool is missing; the pipeline output is in $out/build/out. Copy $out to a host with wabt and a" \
			"node_modules and run this command again to stage it" >&2
		exit 3
	fi
done
if [ ! -x "$repo/node_modules/.bin/wasm-opt" ]; then
	echo "no node_modules in $root for wasm-opt; run bun install, then this command again" >&2
	exit 3
fi
"$repo/scripts/build-kernel.sh" "$out/build/out"
