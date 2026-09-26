#!/bin/sh
# builds static amd64 coreutils, bash, sqlite3 and curl from pinned upstream sources into /out; runs
# inside alpine:3.20 (busybox.sh starts it on the native host)
set -eu
apk add --no-cache build-base perl linux-headers xz > /dev/null
mkdir -p /src /out
cd /src
fetch() {
	[ -f "$(basename "$1")" ] || wget -q "$1"
	echo "$2  $(basename "$1")" | sha256sum -c - > /dev/null
	tar xf "$(basename "$1")"
}
fetch https://ftp.gnu.org/gnu/coreutils/coreutils-9.5.tar.xz \
	cd328edeac92f6a665de9f323c93b712af1858bc2e0d88f3f7100469470a1b8a
fetch https://ftp.gnu.org/gnu/bash/bash-5.2.37.tar.gz \
	9599b22ecd1d5787ad7d3b7bf0c59f312b3396d1e281175dd1f8a4014da621ff
fetch https://www.sqlite.org/2024/sqlite-autoconf-3460100.tar.gz \
	67d3fe6d268e6eaddcae3727fce58fcc8e9c53869bdd07a0c61e38ddf2965071
fetch https://curl.se/download/curl-8.10.1.tar.xz \
	73a4b0e99596a09fa5924a4fb7e4b995a85fda0d18a2c02ab9cf134bebce04ee

j=$(nproc)
(cd coreutils-9.5 && FORCE_UNSAFE_CONFIGURE=1 ./configure -q LDFLAGS=-static --disable-nls \
	--enable-single-binary=symlinks && make -s -j"$j" && cp src/coreutils /out/)
(cd bash-5.2.37 && ./configure -q --enable-static-link --without-bash-malloc --disable-nls \
	&& make -s -j"$j" && cp bash /out/)
(cd sqlite-autoconf-3460100 && gcc -O2 -static -DSQLITE_THREADSAFE=0 -DSQLITE_OMIT_LOAD_EXTENSION \
	-o /out/sqlite3 shell.c sqlite3.c -lm)
(cd curl-8.10.1 && ./configure -q --disable-shared --enable-static --without-ssl --without-libpsl \
	--without-zlib --without-brotli --without-zstd --without-nghttp2 --without-libidn2 \
	--disable-ldap --disable-threaded-resolver && make -s -j"$j" LDFLAGS=-all-static \
	&& cp src/curl /out/)
strip /out/*
sha256sum /out/*
