#!/bin/sh
# in an Alpine 3.20 container with /t holding katybug (static) and zbench-musl: Alpine's dynamic curl (libz.so.1)
# fetches a gzip body and a deflate body with --compressed from a loopback server (busybox nc, always native), and
# the same body plain. usage: zlib-curl-guest.sh native|off|on
# prints one line per fetch: the status, the bytes curl wrote, whether they are the body, the encoding header the
# server sent and the Accept-Encoding the server saw; the prim log (when KATYBUG_PRIM_LOG is set) has the kernels
set -u
arm=${1:?native, off or on}
apk add --no-cache curl > /dev/null 2>&1 || { echo "apk add curl failed"; exit 3; }
cd /t || exit 1
case $arm in
	native) pre="" ;;
	off) pre="env KATYBUG_PRIM=memcpy,memmove,memset,exp,log,pow /t/katybug" ;;
	on) pre="/t/katybug" ;;
esac
seq 1 4000 | sed 's/$/ a line of words that a stream compresses well/' > body.txt
gzip -c body.txt > body.gz
/t/zbench-musl gz c body.txt body.z 15 6 > /dev/null
cat > respond.sh << 'EOF'
#!/bin/sh
file=$1 port=$2 enc=$3
while read -r l; do
	l=$(printf '%s' "$l" | tr -d '\r')
	[ -z "$l" ] && break
	echo "$l" >> /t/req.$port
done
n=$(wc -c < "$file")
printf 'HTTP/1.0 200 OK\r\n'
[ -n "$enc" ] && printf 'Content-Encoding: %s\r\n' "$enc"
printf 'Content-Type: text/plain\r\nContent-Length: %s\r\n\r\n' "$n"
cat "$file"
EOF
fetch() {
	# fetch <port> <file served> <encoding header or -> <curl flags or -> <name>
	rm -f got.txt hdr.txt
	enc=$3
	[ "$enc" = - ] && enc=
	flags=$4
	[ "$flags" = - ] && flags=
	nc -l -p "$1" -e sh /t/respond.sh "$2" "$1" "$enc" > /dev/null 2>&1 &
	for i in $(seq 100); do
		$pre /usr/bin/curl -sS $flags -D hdr.txt -o got.txt -w '%{http_code} %{size_download}\n' "http://127.0.0.1:$1/" > w.txt 2> e.txt
		rc=$?
		[ $rc = 7 ] || break
		sleep 0.2
	done
	wait
	want=body.txt
	[ -z "$flags" ] && want=$2
	same=differs
	cmp -s got.txt "$want" && same=same
	got=$(grep -i '^content-encoding' hdr.txt | tr -d '\r' | cut -d' ' -f2)
	ae=$(grep -i '^accept-encoding' req."$1" 2> /dev/null | tr -d '\r' | cut -d' ' -f2- | cut -c1-40)
	echo "curl $5 rc $rc $(cat w.txt) body $same encoding ${got:-none} accept ${ae:-none} stderr $(grep -v '^katybug:' e.txt | head -c 80)"
}
rm -f req.*
fetch 18081 body.gz gzip --compressed gzip
fetch 18082 body.z deflate --compressed deflate
fetch 18083 body.txt - - plain
fetch 18084 body.gz gzip - gzip-undecoded
