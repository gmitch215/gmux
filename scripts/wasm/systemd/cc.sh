#!/usr/bin/env bash
# meson's compiler for systemd: SYSTEMD_CC (cc-strict) with HDRS and the musl 1.2.6 headers re-added (meson drops
# an -isystem from c_args), archive groups unrolled (fake-llvm's lld repeats a group and refuses a -l
# inside it) and rpath dropped
args=() group=() in=0 link=-Wl,-Bsymbolic
for a in "$@"; do
	case "$a" in
		-c | -E | -S) link= ;;
	esac
	case "$a" in
		-Wl,--start-group) in=1 ;;
		-Wl,--end-group)
			in=0
			args+=("${group[@]}" "${group[@]}")
			group=()
			;;
		-Wl,-rpath* | -Wl,--enable-new-dtags) ;;
		*) if [ $in = 1 ]; then group+=("$a"); else args+=("$a"); fi ;;
	esac
done
exec "$SYSTEMD_CC" "${args[@]}" $link -isystem "$MUSL126" -isystem "$HDRS" \
	-D__NR_setxattrat=463 -D__NR_removexattrat=466 -D__NR_open_tree_attr=467
