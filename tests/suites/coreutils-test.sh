#!/bin/sh
# runs GNU coreutils' shell tests the way make check runs each one (tests/local.mk's
# TESTS_ENVIRONMENT), from the pruned tree tests/suites/coreutils-build.sh makes, unpacked at /cu,
# with /bin/bash as the shell; prints PASS, FAIL, SKIP or ERROR per test. The same script runs on
# the native host and inside a machine; no file a test writes passes 256 MB (ulimit -f).
# usage: coreutils-test.sh <test>...  (default: all of tests.txt)
cd /cu || exit 1
while read -r p; do [ -e "src/$p" ] || ln -s coreutils "src/$p"; done < links.txt
[ $# -gt 0 ] || set -- $(cat tests.txt)
programs=$(tr '\n' ' ' < links.txt)
for t in "$@"; do
	mkdir -p /tmp/cu
	env -i HOME=/tmp TERM=dumb PATH=/cu/src:/bin:/sbin:/usr/bin:/usr/sbin TMPDIR=/tmp/cu \
		VERSION=9.5 PACKAGE_VERSION=9.5 abs_top_builddir=/cu abs_top_srcdir=/cu abs_srcdir=/cu \
		built_programs="$programs" fail=0 host_os=linux-musl host_triplet=x86_64-pc-linux-musl \
		srcdir=. top_srcdir=. CONFIG_HEADER=/cu/lib/config.h \
		CU_TEST_NAME="cu,$(echo "$t" | sed 's,/,-,g')" CC=cc AWK=awk EGREP='grep -E' EXEEXT= \
		MAKE=make PERL=perl SHELL=/bin/bash \
		/bin/bash -c 'ulimit -f 262144; . ./tests/lang-default; . ./tests/envvar-check
			exec timeout 600 /bin/bash "$0"' "$t" \
		> /tmp/cu/log 2>&1 < /dev/null
	case $? in 0) s=PASS ;; 77) s=SKIP ;; 99) s=ERROR ;; *) s=FAIL ;; esac
	echo "$s $t"
	# CU_LOG=1: the end of a test's log when it did not pass
	if [ -n "${CU_LOG:-}" ] && [ $s != PASS ]; then tail -n 15 /tmp/cu/log | sed 's/^/| /'; fi
done
