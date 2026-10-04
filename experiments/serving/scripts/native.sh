#!/usr/bin/env bash
# the same BusyBox httpd built natively from linux-wasm's .config, serving the same /www on
# 127.0.0.1 in a capped container, and the six raw requests scripts/serve.ts sends: one JSON line
# each (bytes, sha256 of the reply with its Date line masked). The masked replies stay in
# /tmp/gmux-serve-native/raw on the host.
# NATIVE_HOST=<ssh alias> SRC=<busybox source on the host> CONFIG=<its .config on the host> scripts/native.sh
set -euo pipefail
host=${NATIVE_HOST:?usage: NATIVE_HOST=<ssh alias> SRC=<busybox source on the host> CONFIG=<busybox .config on the host> scripts/native.sh}
src=${SRC:?SRC is required}
config=${CONFIG:?CONFIG is required}
# the container's caps; PORT is on 127.0.0.1 of the host
ssh "$host" "SRC='$src' CONFIG='$config' PORT='${PORT:-18080}' MEMORY='${MEMORY:-512m}' CPUS='${CPUS:-1}' bash -s" << 'REMOTE'
set -euo pipefail
work=/tmp/gmux-serve-native
mkdir -p "$work/nbuild" "$work/www/cgi-bin" "$work/raw"
if [ ! -x "$work/nbuild/busybox" ]; then
	# the pinned release is the commit under linux-wasm's one upstream patch; its Makefile is not
	# patched for the wasm toolchain
	if [ ! -d "$work/src" ]; then
		mkdir -p "$work/src"
		git -C "$SRC" archive "$(git -C "$SRC" rev-parse HEAD~1)" | tar -x -C "$work/src"
	fi
	cp "$CONFIG" "$work/nbuild/.config"
	(yes '' | make -C "$work/src" O="$work/nbuild" oldconfig > "$work/oldconfig.log" 2>&1) || true
	make -C "$work/src" O="$work/nbuild" -j4 busybox > "$work/make.log" 2>&1
fi
seq 1 400 | head -c 1024 > "$work/www/1k.txt"
seq 1 1000000 > "$work/www/big.txt"
printf '#!/bin/sh\necho "Content-Type: text/plain"\necho\necho hello\n' > "$work/www/cgi-bin/hello.cgi"
printf '#!/bin/sh\necho "Content-Type: text/plain"\necho\nseq 1 3000000\n' > "$work/www/cgi-bin/stream.cgi"
chmod +x "$work"/www/cgi-bin/*.cgi
name=gmux-serve-native
docker run -d --rm --name "$name" --network host --user "$(id -u):$(id -g)" --memory "$MEMORY" --cpus "$CPUS" \
	-v "$work:/w:ro" alpine:3.21 /w/nbuild/busybox httpd -f -p "127.0.0.1:$PORT" -h /w/www > /dev/null
trap 'docker stop "$name" > /dev/null 2>&1 || true' EXIT
for _ in $(seq 1 50); do (exec 3<> "/dev/tcp/127.0.0.1/$PORT") 2> /dev/null && break; sleep 0.1; done
request() {
	local name=$1 req=$2
	exec 3<> "/dev/tcp/127.0.0.1/$PORT"
	printf '%b' "$req" >&3
	cat <&3 > "$work/raw/$name.full"
	exec 3<&- 3>&-
	LC_ALL=C sed -E -e '1,/^\r?$/s/^(Date|Last-Modified|ETag): .*$/\1: MASKED\r/' "$work/raw/$name.full" > "$work/raw/$name"
	printf '{"name":"%s","bytes":%s,"sha256":"%s"}\n' "$name" "$(wc -c < "$work/raw/$name.full" | tr -d ' ')" \
		"$(sha256sum < "$work/raw/$name" | cut -d' ' -f1)"
}
h='Host: serve\r\nConnection: close\r\n\r\n'
request 1k "GET /1k.txt HTTP/1.1\r\n$h"
request 404 "GET /nope HTTP/1.1\r\n$h"
request head "HEAD /1k.txt HTTP/1.1\r\n$h"
request range 'GET /1k.txt HTTP/1.1\r\nHost: serve\r\nRange: bytes=100-199\r\nConnection: close\r\n\r\n'
request big "GET /big.txt HTTP/1.1\r\n$h"
request cgi "GET /cgi-bin/stream.cgi HTTP/1.1\r\n$h"
# what curl gets: status, the headers a hop would pass (names lowercased, sorted) and the body's sha256
curlish() {
	local name=$1 path=$2 flags=$3 hdr="$work/curl.hdr" body="$work/curl.body"
	curl -s --http1.1 $flags -D "$hdr" -o "$body" "http://127.0.0.1:$PORT$path"
	printf '{"curl":"%s","status":%s,"headers":%s,"bytes":%s,"sha256":"%s"}\n' "$name" \
		"$(head -1 "$hdr" | cut -d' ' -f2)" \
		"$(sed 1d "$hdr" | tr -d '\r' | awk -F': ' 'NF > 1 { n = tolower($1); sub(/^[^:]*: /, ""); if (n !~ /^(date|connection|keep-alive|transfer-encoding|last-modified|etag)$/) printf "%s: %s\n", n, $0 }' | LC_ALL=C sort | awk 'BEGIN { printf "[" } { gsub(/"/, "\\\""); printf "%s\"%s\"", (NR > 1 ? "," : ""), $0 } END { printf "]" }')" \
		"$(wc -c < "$body" | tr -d ' ')" "$(sha256sum < "$body" | cut -d' ' -f1)"
}
curlish 1k /1k.txt ''
curlish 404 /nope ''
curlish head /1k.txt -I
curlish range /1k.txt '-r 100-199'
curlish big /big.txt ''
curlish cgi /cgi-bin/stream.cgi ''
REMOTE
