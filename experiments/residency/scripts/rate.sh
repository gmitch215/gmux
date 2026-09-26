#!/bin/bash
# usage: rate.sh <do-name> <seconds> ; logs "epoch_ms instance total_ms dns connect tls ttfb ip" per request at ~1 req/s
B=https://gmux-residency.gmitch215-free.workers.dev
end=$(( $(date +%s) + $2 ))
while [ $(date +%s) -lt $end ]; do
	s=$(python3 -c 'import time;print(int(time.time()*1000))')
	out=$(curl -s -m 120 -w '\n%{time_namelookup} %{time_connect} %{time_appconnect} %{time_starttransfer} %{remote_ip}' "$B/who?do=$1")
	e=$(python3 -c 'import time;print(int(time.time()*1000))')
	inst=$(echo "$out" | head -1 | grep -o '"instance":"[^"]*"' | cut -c13-20)
	echo "$s ${inst:-ERR} $((e - s)) $(echo "$out" | tail -1)"
	sleep 1
done
