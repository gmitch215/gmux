#!/usr/bin/env bash
# random bytes, so nothing between the object and the asset store can compress them
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p assets
head -c 1024 /dev/urandom > assets/tiny.bin
for k in 256 512 1024 4096 8192 16384; do
	name=a${k}k
	[ $k -ge 1024 ] && name=a$((k / 1024))m
	head -c $((k * 1024)) /dev/urandom > assets/$name.bin
done
