#!/bin/sh
# builds static amd64 GNU gzip from the pinned upstream source into /out (gzip, and gzip.dbg with its symbols for
# inflate-sigs.ts); runs inside alpine:3.20 like userland-build.sh
set -eu
{ command -v cc > /dev/null && command -v xz > /dev/null && [ -d /usr/include/linux ]; } \
	|| apk add --no-cache build-base linux-headers xz > /dev/null
mkdir -p /src /out
cd /src
[ -f gzip-1.13.tar.xz ] || wget -q https://ftp.gnu.org/gnu/gzip/gzip-1.13.tar.xz
echo "7454eb6935db17c6655576c2e1b0fabefd38b4d0936e0f87f48cd062ce91a057  gzip-1.13.tar.xz" | sha256sum -c - > /dev/null
tar xf gzip-1.13.tar.xz
(cd gzip-1.13 && FORCE_UNSAFE_CONFIGURE=1 ./configure -q LDFLAGS=-static && make -s -j"$(nproc)" \
	&& cp gzip /out/gzip.dbg && cp gzip /out/gzip)
strip /out/gzip
sha256sum /out/gzip /out/gzip.dbg
