#!/usr/bin/env bash
# lists the kernel source files and headers a build compiled, one kernel-relative path per line
# usage: scripts/kernel-built-files.sh <kernel build dir (O=)> <kernel source dir> > src/kernel/built-files.txt
# rerun it after a change to the kernel config; scripts/kernel-cve-triage.ts reads the list
set -euo pipefail
build=${1:?usage: scripts/kernel-built-files.sh <kernel build dir> <kernel source dir>}
src=${2:?usage: scripts/kernel-built-files.sh <kernel build dir> <kernel source dir>}
find "$build" -name '.*.o.cmd' -print0 | xargs -0 cat \
	| sed -n -e "s|^source_.* := $src/||p" \
		-e "s|^ *$src/\(.*\.[chS]\) \\\\\$|\1|p" \
		-e 's|^ *\([^/$. ][^ ]*\.[chS]\) \\$|\1|p' \
	| grep -v '/generated/' | LC_ALL=C sort -u
