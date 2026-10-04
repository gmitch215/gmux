#!/bin/sh
# builds GNU coreutils 9.5 (static, one binary behind symlinks) and bash 5.2.37 (static) from the
# tarballs in /t3, the pins of tests/c/katybug/userland-build.sh, and prunes the build tree to what
# the test suite reads: /t3/cu.tar.gz holds cu/ (tests/, build-aux/, lib/config.h, src/coreutils,
# links.txt naming src/'s symlinks, tests.txt listing the shell tests) and /t3/bash is the shell the
# tests run under; runs inside alpine:3.20 (tests/suites/coreutils.sh starts it on the native host)
set -eu
apk add --no-cache build-base perl linux-headers xz > /dev/null
cd /t3
[ -f coreutils-9.5.tar.xz ] || wget -q https://ftp.gnu.org/gnu/coreutils/coreutils-9.5.tar.xz
[ -f bash-5.2.37.tar.gz ] || wget -q https://ftp.gnu.org/gnu/bash/bash-5.2.37.tar.gz
echo "cd328edeac92f6a665de9f323c93b712af1858bc2e0d88f3f7100469470a1b8a  coreutils-9.5.tar.xz" | sha256sum -c - > /dev/null
echo "9599b22ecd1d5787ad7d3b7bf0c59f312b3396d1e281175dd1f8a4014da621ff  bash-5.2.37.tar.gz" | sha256sum -c - > /dev/null
mkdir -p /b
cd /b
tar xf /t3/coreutils-9.5.tar.xz
tar xf /t3/bash-5.2.37.tar.gz
j=$(nproc)
(cd coreutils-9.5 && FORCE_UNSAFE_CONFIGURE=1 ./configure -q LDFLAGS=-static --disable-nls \
	--enable-single-binary=symlinks --enable-install-program=arch && make -s -j"$j")
(cd bash-5.2.37 && ./configure -q --enable-static-link --without-bash-malloc --disable-nls \
	&& make -s -j"$j")
strip coreutils-9.5/src/coreutils bash-5.2.37/bash
mkdir -p cu/src cu/lib
cd coreutils-9.5
cp -R tests build-aux ../cu/
cp lib/config.h ../cu/lib/
cp src/coreutils ../cu/src/
for f in src/*; do
	[ -L "$f" ] && [ "$(readlink "$f")" = coreutils ] && echo "${f#src/}"
done | sort > ../cu/links.txt
# make check's list, the shell tests only: the .pl ones need perl, which the machine has not
sed -n '/^all_tests =/,/^$/p' tests/local.mk | grep -o 'tests/[^ ]*\.sh' > ../cu/tests.txt
# the environment make check gives each test, for the driver to match
sed -n '/^TESTS_ENVIRONMENT =/,/^$/p' tests/local.mk > ../cu/environment.txt
cd /b
tar -czf /t3/cu.tar.gz cu
cp bash-5.2.37/bash /t3/bash
echo "$(wc -l < cu/tests.txt) tests, $(wc -l < cu/links.txt) programs"
