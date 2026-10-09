#!/usr/bin/env bash
# the timed samples of the serving rig, one process per sample, pinned to CPUS, the host's timing lock taken
# around each sample only, a quiet.sh reading (QUIET) or the load average before each. One JSON line per
# sample in $OUT/<part>.jsonl. A sample that exits non-zero, or whose reply hash differs from
# EXPECT_<workload>, fails its cell; three failures in a row end the sweep. The done marker (DONE) is
# written whatever the exit status.
#   serve: serve.ts MODE=bench for each workload, ROUNDS requests per sample, RUNS samples per workload
#   ingest: serve.ts WORKLOAD=ingest for each size in BODY_MIBS ("1 8 32"), ROUNDS so that about INGEST_BYTES_PER_SAMPLE (256) MiB go in a sample
#   sendfile: the tests/c/sendfile probe's CPU per transfer, natively and in the machine, for each kind and size
# usage: GMUX_BUILD=<build dir> CPUS=<list or none> OUT=<dir> DONE=<marker> EXPECT_small=<sha> ... bench.sh [serve] [sendfile]
# KERNEL (default $GMUX_BUILD/kernel), WORKLOADS, RUNS (3), ROUNDS (25), BYTES_MACHINE (512 MiB) and BYTES_NATIVE
# (2 GiB) per cell, PROBE (the wasm probe), NATIVE (the native probe), WORK (the prep output) set the rest.
set -o pipefail
here=$(cd "$(dirname "$0")" && pwd)
: "${GMUX_BUILD:?}" "${CPUS:?}" "${OUT:?}" "${DONE:?}"
trap 'echo $? > "$DONE"' EXIT
parts=("$@")
[ ${#parts[@]} -gt 0 ] || parts=(serve sendfile)
kernel=${KERNEL:-$GMUX_BUILD/kernel}
runs=${RUNS:-3}
rounds=${ROUNDS:-25}
lock=${LOCK:-/tmp/paisley-timing.lock}
pin=()
[ "$CPUS" = none ] || pin=(taskset -c "$CPUS")
mkdir -p "$OUT"
loadavg() { cut -d' ' -f1-3 /proc/loadavg 2> /dev/null || uptime | sed 's/.*: //'; }
fails=0
dead=" "
# sample <part> <cell> <json fields before out> <expected sha or empty> <command...>
sample() {
	local part=$1 cell=$2 head=$3 expect=$4
	shift 4
	case $dead in *" $cell "*) return 0 ;; esac
	until mkdir "$lock" 2> /dev/null; do sleep 5; done
	local avg q="" text rc ok=0 json
	avg=$(loadavg)
	[ -n "${QUIET:-}" ] && q=$(bash "$QUIET" "$CPUS")
	text=$(timeout -s KILL "${LIMIT:-600}" "$@" 2> /dev/null | grep -E '^\{"(mode|host)"' | tail -1)
	rc=$?
	rmdir "$lock"
	if [ "$rc" -eq 0 ] && [ -n "$text" ]; then
		if [ "$expect" = sinkCounted ]; then
			[[ "$text" == *'"sinkCounted":true'* ]] && [[ "$text" == *'"crashed":"null"'* ]] && ok=1
		elif [ -n "$expect" ]; then
			[[ "$text" == *"\"sha256\":\"$expect\""* ]] && [[ "$text" == *'"crashed":"null"'* ]] && ok=1
		else
			[[ "$text" == *'"ok":true'* ]] && ok=1
		fi
	fi
	json=${text:-null}
	echo "{$head,\"loadavg\":\"$avg\",\"quiet\":\"$q\",\"rc\":$rc,\"ok\":$ok,\"out\":$json}" >> "$OUT/$part.jsonl"
	if [ "$ok" -eq 1 ]; then
		fails=0
	else
		fails=$((fails + 1))
		dead="$dead$cell "
	fi
	[ "$fails" -lt 3 ] || { echo "STOP three failed samples in a row" >> "$OUT/$part.jsonl"; exit 1; }
}

for part in "${parts[@]}"; do
	: > "$OUT/$part.jsonl"
	case $part in
	serve)
		for run in $(seq "$runs"); do
			for w in ${WORKLOADS:-small cgi big bighash bigimports stream post catcgi}; do
				# bighash is big with the reply hashed inside each timed round, as the first table was taken;
				# bigimports is big with a timer around every plain kernel import
				workload=${w%hash}
				workload=${workload%imports}
				hashed=0
				imports=0
				[ "$w" != "${workload}hash" ] || hashed=1
				[ "$w" != "${workload}imports" ] || imports=1
				expect_var=EXPECT_$workload
				sample serve "$w" "\"workload\":\"$w\",\"run\":$run" "${!expect_var:?$expect_var}" \
					env MODE=bench WORKLOAD="$workload" HASH="$hashed" IMPORTS="$imports" ROUNDS="$rounds" GMUX_BUILD="$GMUX_BUILD" "${pin[@]}" \
					node --no-warnings --experimental-strip-types "$here/serve.ts" "$kernel"
			done
		done
		;;
	ingest)
		# a body of each size in BODY_MIBS to the sink CGI, written in 64 KiB chunks; each sample must see the CGI count every byte
		for run in $(seq "$runs"); do
			for mib in ${BODY_MIBS:-1 8 32}; do
				sample ingest "ingest-$mib" "\"mib\":$mib,\"run\":$run" sinkCounted \
					env MODE=bench WORKLOAD=ingest BODY_MIB="$mib" ROUNDS=$((${INGEST_BYTES_PER_SAMPLE:-256} / mib)) GMUX_BUILD="$GMUX_BUILD" "${pin[@]}" \
					node --no-warnings --experimental-strip-types "$here/serve.ts" "$kernel"
			done
		done
		;;
	sendfile)
		: "${NATIVE:?}" "${PROBE:?}" "${WORK:?}"
		for run in $(seq "$runs"); do
			for size in 4096 65536 1048576; do
				for kind in sendfile splice rw; do
					# the host order alternates by run
					for i in 0 1; do
						if [ $(((i + run) % 2)) -eq 0 ]; then
							sample sendfile "native-$kind-$size" "\"host\":\"native\",\"kind\":\"$kind\",\"size\":$size,\"run\":$run" "" \
								"${pin[@]}" bash "$here/sendfile-native.sh" "$NATIVE" "$kind" "$size" $((${BYTES_NATIVE:-2147483648} / size))
						else
							sample sendfile "machine-$kind-$size" "\"host\":\"machine\",\"kind\":\"$kind\",\"size\":$size,\"run\":$run" "" \
								env KIND="$kind" SIZE="$size" CALLS=$((${BYTES_MACHINE:-536870912} / size)) PROBE="$PROBE" WORK="$WORK" \
								"${pin[@]}" node --no-warnings --experimental-strip-types "$here/sendfile.ts" "$kernel"
						fi
					done
				done
			done
		done
		;;
	*)
		echo "unknown part $part" >&2
		exit 2
		;;
	esac
done
exit 0
