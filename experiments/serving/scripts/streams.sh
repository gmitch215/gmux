#!/usr/bin/env bash
# one serve.ts MODE=streams process per cell (each boots the site's machine fresh): K stalled readers
# of the big file, static (httpd's sendfile) and cgi (a shell and cat behind httpd). One JSON line per
# cell in $OUT; a cell that exits non-zero or prints no result gets a line with its status instead.
# The done marker (DONE) is written whatever the exit status.
# usage: KERNEL=<kernel dir> OUT=<file> DONE=<marker> [KS="0 1 2 4 8 16 24 32"] [WORKLOADS="static cgi"] streams.sh
here=$(cd "$(dirname "$0")" && pwd)
: "${KERNEL:?}" "${OUT:?}" "${DONE:?}"
trap 'echo $? > "$DONE"' EXIT
for workload in ${WORKLOADS:-static cgi}; do
	for k in ${KS:-0 1 2 4 8 16 24 32}; do
		text=$(MODE=streams K=$k WORKLOAD=$workload timeout -s KILL "${LIMIT:-900}" \
			node --no-warnings --experimental-strip-types "$here/serve.ts" "$KERNEL" 2> /dev/null \
			| grep -E '^\{"mode":"streams","kernel":"[^"]*","workload"' | tail -1)
		rc=$?
		if [ -n "$text" ]; then echo "$text" >> "$OUT"; else echo "{\"kernel\":\"$KERNEL\",\"workload\":\"$workload\",\"k\":$k,\"failed\":true,\"rc\":$rc}" >> "$OUT"; fi
	done
done
