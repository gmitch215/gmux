#!/usr/bin/env bash
# package census: ~50 packages for wasm32-linux-musl with scripts/cc-strict; libraries install into a
# per-run prefix so later packages link against them. no rm anywhere: each run builds in its own tree,
# in the container's /tmp by default, so `docker run --rm` discards it (1.6 GB a round) and only the
# outputs, logs and results reach /rig/census; CENSUS_BUILD=<dir> keeps a tree to look into
# ROUND tags the out, logs and build dirs (default 9); EXTRA_CFLAGS adds to every compile (-msimd128)
set -uo pipefail
W=/rig/linux-wasm/workspace
export REAL_LLVM=$W/install/llvm/bin
export LINUX_WASM=/rig/linux-wasm
CC=/rig/repo/scripts/cc-strict
SYSROOT=$W/install/musl-wasm32_nommu
HDRS=$W/install/busybox-kernel-headers-wasm32_nommu
D=/rig/census
ROUND=${ROUND:-9}
mkdir -p $D/src $D/out$ROUND $D/logs$ROUND
RUN=$(date +%s)
B=${CENSUS_BUILD:-/tmp/census}/b$ROUND-$RUN
P=$B/prefix
mkdir -p $B $P/include $P/lib
RESULTS=$D/results$ROUND-$RUN.tsv
: > $RESULTS
T="--target=wasm-linux-musl -march=wasm32"
CFLAGS="$T --sysroot=$SYSROOT -isystem $HDRS -D__linux__ -fPIC -O2 ${EXTRA_CFLAGS:-}"
CPPFLAGS="-I$P/include -I$P/include/ncursesw"
LDFLAGS="$T --sysroot=$SYSROOT -Wl,-shared -fPIC -L$P/lib"
AR=$LINUX_WASM/tools/fake-llvm/llvm-ar
RANLIB=$LINUX_WASM/tools/fake-llvm/llvm-ranlib
PKG_CONFIG_PATH=$P/lib/pkgconfig
PKG_CONFIG_LIBDIR=$P/lib/pkgconfig
CONFIG_SITE=/rig/repo/scripts/wasm/config.site
# for a configure that runs its test programs (docker/census.Dockerfile's image, a staged build in
# $D/build): GMUX_TARGET_RUN=$TARGET_RUN
TARGET_RUN="env GMUX_BUILD=$D/build node /rig/repo/scripts/wasm/target-run.ts"
export CC CFLAGS CPPFLAGS LDFLAGS AR RANLIB PKG_CONFIG_PATH PKG_CONFIG_LIBDIR CONFIG_SITE
HOST="--host=wasm32-unknown-linux-musl --build=x86_64-linux-gnu"
J=8

fetch() { # $1 url $2 file
	[ -s "$D/src/$2" ] && return 0
	wget -q -T 120 --limit-rate=3m -O "$D/src/$2.part" "$1" && mv "$D/src/$2.part" "$D/src/$2"
}
record() {
	printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> $RESULTS
	echo "== $1: $2 ($3)"
}
firsterr() { grep -h -m1 -E 'cc-strict: [a-z]|error:|Error [0-9]|No such file|not found|cannot' "$@" 2> /dev/null | cut -c1-200; }
iswasm() { [ -f "$1" ] && head -c 4 "$1" | od -An -c | grep -q 'a   s   m'; }
checkwasm() { # $1 name $2 artifact
	if iswasm "$2"; then
		cp "$2" "$D/out$ROUND/$1.wasm"
		record "$1" built "$(stat -c %s "$2") B"
	elif [ -f "$2.unresolved" ]; then
		record "$1" unresolved "$(firsterr $D/logs$ROUND/$1.make.log)"
	else record "$1" no-artifact "$(firsterr $D/logs$ROUND/$1.make.log)"; fi
}
unpack() { # $1 name $2 url $3 file -> cd into the single top directory
	fetch "$2" "$3" || {
		record "$1" download-failed "$2"
		return 1
	}
	mkdir -p "$B/$1" && tar -xf "$D/src/$3" -C "$B/$1" || {
		record "$1" untar-failed -
		return 1
	}
	cd "$B/$1"/*/ || return 1
}
conf() { # $1 name, rest: configure args
	local n=$1
	shift
	./configure $HOST "$@" > $D/logs$ROUND/$n.configure.log 2>&1 || {
		record $n configure-failed "$(tail -1 $D/logs$ROUND/$n.configure.log | cut -c1-160)"
		return 1
	}
}
mk() { # $1 name, rest: make args
	local n=$1
	shift
	make -j$J "$@" > $D/logs$ROUND/$n.make.log 2>&1 || {
		record $n make-failed "$(firsterr $D/logs$ROUND/$n.make.log)"
		return 1
	}
}
# name url file artifact configure-args...
prog() {
	local n=$1 url=$2 file=$3 art=$4
	shift 4
	(unpack $n $url $file && conf $n ${STATIC_ARGS---disable-shared --enable-static} "$@" && mk $n && checkwasm $n "$art")
}
# name url file lib-to-check configure-args...
lib() {
	local n=$1 url=$2 file=$3 want=$4
	shift 4
	(unpack $n $url $file && conf $n --prefix=$P --disable-shared --enable-static "$@" && mk $n \
		&& make install >> $D/logs$ROUND/$n.make.log 2>&1 \
		&& { [ -f "$P/lib/$want" ] && record $n lib-built "$want" || record $n no-artifact "$want missing"; })
}
GNU=https://ftp.gnu.org/gnu
T0=$(date +%s)

# #region libraries
(unpack zlib https://zlib.net/fossils/zlib-1.3.1.tar.gz zlib.tgz && CHOST=wasm32 ./configure --static --prefix=$P > $D/logs$ROUND/zlib.configure.log 2>&1 \
	&& mk zlib minigzip libz.a && make install >> $D/logs$ROUND/zlib.make.log 2>&1 && checkwasm zlib minigzip)
lib ncurses $GNU/ncurses/ncurses-6.5.tar.gz ncurses.tgz libncursesw.a --without-cxx --without-cxx-binding --without-ada \
	--without-tests --without-progs --without-manpages --disable-db-install --with-build-cc=gcc --enable-widec --with-termlib \
	--enable-overwrite --enable-pc-files --with-pkg-config-libdir=$P/lib/pkgconfig
# programs probe the unsuffixed names
ln -sf libncursesw.a $P/lib/libcurses.a
ln -sf libtinfow.a $P/lib/libtinfo.a
ln -sf libncursesw.a $P/lib/libncurses.a
lib readline $GNU/readline/readline-8.2.tar.gz readline.tgz libreadline.a --with-curses bash_cv_termcap_lib=libtinfow
lib libevent https://github.com/libevent/libevent/releases/download/release-2.1.12-stable/libevent-2.1.12-stable.tar.gz libevent.tgz \
	libevent.a --disable-openssl --disable-thread-support --disable-samples --disable-libevent-regress
lib pcre2 https://github.com/PCRE2Project/pcre2/releases/download/pcre2-10.44/pcre2-10.44.tar.gz pcre2.tgz libpcre2-8.a --disable-jit
lib expat https://github.com/libexpat/libexpat/releases/download/R_2_6_3/expat-2.6.3.tar.gz expat.tgz libexpat.a --without-docbook --without-examples --without-tests
lib libffi https://github.com/libffi/libffi/releases/download/v3.4.6/libffi-3.4.6.tar.gz libffi.tgz libffi.a
lib libxml2 https://download.gnome.org/sources/libxml2/2.13/libxml2-2.13.4.tar.xz libxml2.txz libxml2.a --without-python --without-lzma --with-zlib=$P
lib jansson https://github.com/akheron/jansson/releases/download/v2.14/jansson-2.14.tar.gz jansson.tgz libjansson.a
(unpack openssl https://github.com/openssl/openssl/releases/download/openssl-3.3.2/openssl-3.3.2.tar.gz openssl.tgz \
	&& { ./Configure linux-generic32 no-asm no-threads no-shared no-tests no-afalgeng no-async no-dso no-secure-memory --prefix=$P --libdir=lib \
		CC=$CC CFLAGS="$CFLAGS" LDFLAGS="$LDFLAGS" AR=$AR RANLIB=$RANLIB > $D/logs$ROUND/openssl.configure.log 2>&1 \
		|| {
			record openssl configure-failed "$(tail -1 $D/logs$ROUND/openssl.configure.log | cut -c1-160)"
			exit
		}; } \
	&& mk openssl && make install_dev >> $D/logs$ROUND/openssl.make.log 2>&1 && checkwasm openssl apps/openssl)
(unpack mbedtls https://github.com/Mbed-TLS/mbedtls/releases/download/mbedtls-3.6.2/mbedtls-3.6.2.tar.bz2 mbedtls.tbz \
	&& mk mbedtls lib programs CC=$CC CFLAGS="$CFLAGS" LDFLAGS="$LDFLAGS" AR=$AR && make install DESTDIR=$P >> $D/logs$ROUND/mbedtls.make.log 2>&1 && checkwasm mbedtls programs/ssl/ssl_client2)
(unpack zstd https://github.com/facebook/zstd/releases/download/v1.5.6/zstd-1.5.6.tar.gz zstd.tgz \
	&& mk zstd -C programs zstd HAVE_THREAD=0 HAVE_ZLIB=0 HAVE_LZMA=0 HAVE_LZ4=0 && checkwasm zstd programs/zstd)
(unpack lz4 https://github.com/lz4/lz4/releases/download/v1.10.0/lz4-1.10.0.tar.gz lz4.tgz && mk lz4 -C programs lz4 && checkwasm lz4 programs/lz4)
# #endregion

# #region programs carried from earlier rounds
(unpack bzip2 https://sourceware.org/pub/bzip2/bzip2-1.0.8.tar.gz bzip2.tgz \
	&& mk bzip2 bzip2 CC=$CC CFLAGS="$CFLAGS" LDFLAGS="$LDFLAGS" AR=$AR RANLIB=$RANLIB && checkwasm bzip2 bzip2)
(unpack lua https://www.lua.org/ftp/lua-5.4.7.tar.gz lua.tgz && cd src \
	&& mk lua lua CC=$CC MYCFLAGS="$CFLAGS -DLUA_USE_POSIX" MYLDFLAGS="$LDFLAGS" AR="$AR rcu" RANLIB=$RANLIB && checkwasm lua lua)
(mkdir -p $B/sqlite && cd $B/sqlite && fetch https://www.sqlite.org/2024/sqlite-amalgamation-3470200.zip sqlite.zip \
	&& unzip -q "$D/src/sqlite.zip" && cd sqlite-amalgamation-3470200 \
	&& {
		$CC $CFLAGS -DSQLITE_THREADSAFE=0 -DSQLITE_OMIT_LOAD_EXTENSION shell.c sqlite3.c $LDFLAGS -o sqlite3 > $D/logs$ROUND/sqlite.make.log 2>&1
		checkwasm sqlite sqlite3
	})
prog jq https://github.com/jqlang/jq/releases/download/jq-1.7.1/jq-1.7.1.tar.gz jq.tgz jq --without-oniguruma --disable-docs --disable-valgrind
prog make $GNU/make/make-4.4.1.tar.gz make.tgz make --disable-nls --without-guile --disable-load
STATIC_ARGS="" prog dash http://gondor.apana.org.au/~herbert/dash/files/dash-0.5.12.tar.gz dash.tgz src/dash
prog xz https://github.com/tukaani-project/xz/releases/download/v5.6.3/xz-5.6.3.tar.gz xz.tgz src/xz/xz --disable-nls --disable-threads --disable-doc --disable-sandbox
prog curl https://curl.se/download/curl-8.10.1.tar.gz curl.tgz src/curl --with-mbedtls=$P --without-libpsl --disable-threaded-resolver \
	--with-zlib=$P --without-brotli --without-zstd --without-nghttp2 --without-libidn2 --disable-ldap --disable-shared ac_cv_func_socket=yes
(unpack lighttpd https://download.lighttpd.net/lighttpd/releases-1.4.x/lighttpd-1.4.76.tar.gz lighttpd.tgz \
	&& cmake -S . -B build -DCMAKE_TOOLCHAIN_FILE=/rig/repo/scripts/wasm/toolchain.cmake -DCMAKE_C_FLAGS="$CFLAGS" \
		-DCMAKE_EXE_LINKER_FLAGS="$LDFLAGS" -DBUILD_STATIC=ON -DWITH_PCRE2=OFF -DWITH_ZLIB=OFF -DWITH_BZIP=OFF > $D/logs$ROUND/lighttpd.configure.log 2>&1 \
	&& printf 'PLUGIN_INIT(mod_dirlisting)\nPLUGIN_INIT(mod_staticfile)\n' > src/plugin-static.h \
	&& mk lighttpd -C build lighttpd && checkwasm lighttpd build/build/lighttpd)
# #endregion

# #region programs
prog grep $GNU/grep/grep-3.11.tar.xz grep.txz src/grep --disable-nls
prog sed $GNU/sed/sed-4.9.tar.xz sed.txz sed/sed --disable-nls
prog gawk $GNU/gawk/gawk-5.3.1.tar.xz gawk.txz gawk --disable-nls --disable-extensions
prog diffutils $GNU/diffutils/diffutils-3.10.tar.xz diffutils.txz src/diff --disable-nls
prog findutils $GNU/findutils/findutils-4.10.0.tar.xz findutils.txz find/find --disable-nls
prog coreutils $GNU/coreutils/coreutils-9.5.tar.xz coreutils.txz src/ls --disable-nls --without-openssl --enable-no-install-program=stdbuf
prog tar $GNU/tar/tar-1.35.tar.xz tar.txz src/tar --disable-nls
prog gzip $GNU/gzip/gzip-1.13.tar.xz gzip.txz gzip
prog patch $GNU/patch/patch-2.7.6.tar.xz patch.txz src/patch
prog m4 $GNU/m4/m4-1.4.19.tar.xz m4.txz src/m4 --disable-nls
prog bison $GNU/bison/bison-3.8.2.tar.xz bison.txz src/bison --disable-nls
prog bash $GNU/bash/bash-5.2.37.tar.gz bash.tgz bash --without-bash-malloc --disable-nls --with-curses
prog less https://www.greenwoodsoftware.com/less/less-661.tar.gz less.tgz less --with-regex=posix
prog nano https://www.nano-editor.org/dist/v8/nano-8.2.tar.xz nano.txz src/nano --disable-nls --enable-utf8
prog file https://astron.com/pub/file/file-5.45.tar.gz file.tgz src/file --disable-shared
prog tmux https://github.com/tmux/tmux/releases/download/3.5a/tmux-3.5a.tar.gz tmux.tgz tmux --disable-utf8proc
prog htop https://github.com/htop-dev/htop/releases/download/3.3.0/htop-3.3.0.tar.xz htop.txz htop --disable-unicode
(unpack vim https://github.com/vim/vim/archive/refs/tags/v9.1.0800.tar.gz vim.tgz && conf vim --with-features=normal --disable-gui \
	--without-x --with-tlib=tinfow --disable-nls && mk vim && checkwasm vim src/vim)
prog git https://www.kernel.org/pub/software/scm/git/git-2.47.0.tar.xz git.txz git --without-tcltk --without-python --without-openssl \
	--without-curl --without-expat --without-iconv --with-zlib=$P
(unpack redis https://download.redis.io/releases/redis-7.4.1.tar.gz redis.tgz \
	&& mk redis MALLOC=libc USE_SYSTEMD=no BUILD_TLS=no uname_S=Linux CC=$CC LDFLAGS="$LDFLAGS" AR=$AR OPTIMIZATION=-O2 \
		CFLAGS="$CFLAGS -DREDISMODULE_ATTR_COMMON=__attribute__\\(\\(weak\\)\\)" \
	&& checkwasm redis src/redis-server)
(unpack nginx https://nginx.org/download/nginx-1.26.2.tar.gz nginx.tgz \
	&& { GMUX_TARGET_RUN=$TARGET_RUN ./configure --crossbuild=Linux::wasm32 --with-cc=$CC --with-cc-opt="$CFLAGS $CPPFLAGS" --with-ld-opt="$LDFLAGS" \
		--without-http_rewrite_module --without-http_gzip_module > $D/logs$ROUND/nginx.configure.log 2>&1 \
		|| {
			record nginx configure-failed "$(tail -2 $D/logs$ROUND/nginx.configure.log | tr '\n' ' ' | cut -c1-160)"
			exit
		}; } \
	&& mk nginx && checkwasm nginx objs/nginx)
prog dropbear https://matt.ucc.asn.au/dropbear/releases/dropbear-2024.86.tar.bz2 dropbear.tbz dropbear --disable-zlib --disable-syslog \
	--disable-lastlog --disable-utmp --disable-utmpx --disable-wtmp --disable-wtmpx --disable-pututline --disable-pututxline
prog openssh https://cdn.openbsd.org/pub/OpenBSD/OpenSSH/portable/openssh-9.9p1.tar.gz openssh.tgz ssh --with-ssl-dir=$P \
	--with-zlib=$P --disable-strip --without-pam --disable-etc-default-login
(unpack perl https://www.cpan.org/src/5.0/perl-5.40.0.tar.gz perl.tgz \
	&& mkdir -p $B/perl-target \
	&& { PATH=/rig/repo/scripts/wasm/target:$PATH GMUX_TARGET_RUN=$TARGET_RUN ./Configure -des -Dusecrosscompile \
		-Dtargethost=localhost -Dtargetdir=$B/perl-target -Dtargetarch=wasm32-linux -Dcc=$CC \
		-Dnm=$REAL_LLVM/llvm-nm -Dar=$AR -Dranlib=$RANLIB -Dccflags="$CFLAGS -D_GNU_SOURCE" -Dldflags="$LDFLAGS" -Dprefix=/usr \
		> $D/logs$ROUND/perl.configure.log 2>&1 || {
		record perl configure-failed "$(tail -2 $D/logs$ROUND/perl.configure.log | tr '\n' ' ' | cut -c1-160)"
		exit
	}; } \
	&& mk perl && checkwasm perl perl)
(unpack python https://www.python.org/ftp/python/3.8.20/Python-3.8.20.tar.xz python.txz \
	&& READELF=$LINUX_WASM/tools/fake-llvm/llvm-readelf conf python --with-build-python=python3 --disable-ipv6 --without-ensurepip --disable-shared \
	&& mk python python && checkwasm python python)
# #endregion
echo "CENSUS6-DONE $(($(date +%s) - T0))s results=$RESULTS"
