// on a deployed Free machine: a signal handler that blocks, pthreads, and the POSIX
// surface the kernel config now builds (sockets, flock, eventfd, epoll, timerfd, inotify, /dev/null)
const B = process.env.G08_URL ?? 'https://gmux-boot.gmitch215-free.workers.dev';
const cases = [
	['blocking signal handler', 'sig; echo END-$((1+1))', (o) => o.includes('handler slept') && o.includes('after pause')],
	['pthreads', 'thr; echo END-$((1+1))', (o) => o.includes('threads count 40000')],
	[
		'POSIX surface',
		'ifconfig lo 127.0.0.1 up; posix; echo END-$((1+1))',
		(o) => (o.match(/^PASS /gm) ?? []).length === 8 && !/^FAIL /m.test(o)
	]
];
let failed = 0;
for (const [label, cmd, check] of cases) {
	const name = `posix-${Date.now()}`;
	const get = async (path) => (await fetch(`${B}${path}${path.includes('?') ? '&' : '?'}do=${name}`)).json().catch(() => ({}));
	await get('/burn?iters=3e8');
	await get('/boot?pages=1200&wall=20000');
	let out = (await get(`/exec?cmd=${encodeURIComponent(cmd)}&wall=6000`)).out ?? '';
	for (let i = 0; i < 8 && !out.includes('END-2'); i++) out += (await get('/run?until=END-2&wall=5000')).out ?? '';
	const ok = check(out);
	if (!ok) failed++;
	console.log(ok ? 'PASS' : 'FAIL', label.padEnd(30), ok ? '' : JSON.stringify(out.slice(-300)));
}
process.exit(failed ? 1 : 0);
