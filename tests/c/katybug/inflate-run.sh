#!/bin/sh
# runs the cases of an inflate.sh corpus (run from inside it): inflate-run.sh <arm> <out dir> [katybug]
# arm native runs ./gzip; the others run it under katybug: off (kernels off), kernel (the crc loop only) and on (the host
# inflate, with its statistics logged per case). Each case leaves <n>.out, <n>.err and <n>.rc in the out dir
set -u
arm=$1
o=$2
kb=${3:-}
top=$(pwd)
mkdir -p "$o"
case $arm in
	native) pre= ;;
	off) pre="env KATYBUG_PRIM=0 $kb" ;;
	kernel) pre="env KATYBUG_PRIM=gzcrc $kb" ;;
	on) pre="env KATYBUG_HOSTINFLATE=1 $kb" ;;
esac
i=0
while IFS='|' read -r name expect cmd; do
	i=$((i + 1))
	W=w$arm$i.$$
	p=$pre
	if [ "$arm" = on ]; then
		: > "$o/$i.log"
		p="env KATYBUG_STATS=1 KATYBUG_PRIM_LOG=$o/$i.log KATYBUG_HOSTINFLATE=1 $kb"
	fi
	G="$p $top/gzip" W=$W sh -c "$cmd" > "$o/$i.out" 2> "$o/$i.err" < /dev/null
	echo $? > "$o/$i.rc"
	# katybug's own report lines (KATYBUG_STATS) share stderr with the guest
	if [ "$arm" = on ]; then
		grep -v '^katybug: ' "$o/$i.err" > "$o/$i.err.f" || true
		mv "$o/$i.err.f" "$o/$i.err"
	fi
done < cases.txt
echo "$i" > "$o/count"
