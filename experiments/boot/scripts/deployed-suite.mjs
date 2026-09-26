// tests/c probes and libc-test's thread suite on a deployed Free machine, one machine each
const B = process.env.G08_URL ?? 'https://gmux-boot.gmitch215-free.workers.dev';
const passes = (n) => (o) => (o.match(/^PASS /gm) ?? []).length === n && !/^FAIL /m.test(o);
const probes = [
	['isolation', 'isolation', (o) => o.includes('TRUST kernel-address write accepted') && passes(14)(o)],
	['vf', 'vf', (o) => o.includes('second exited 7') && o.includes('third exited 9')],
	['sig', 'sig', (o) => o.includes('handler slept') && o.includes('after pause')],
	['thr', 'thr', (o) => o.includes('threads count 40000')],
	['spin', 'spin', passes(2)],
	['stack', 'stack', passes(2)],
	['time', 'time', passes(5)],
	[
		'katybug',
		'/bin/hello-x86; /bin/hello-a64; /bin/guest-x86 > /tmp/kx; echo "x86 rc $?"; /bin/guest-a64 > /tmp/ka; ' +
			'echo "a64 rc $?"; cmp /tmp/kx /tmp/ka && echo same; /bin/signals-x86 > /tmp/sx; echo "signals rc $?"; ' +
			'/bin/signals-a64 > /tmp/sa; cmp /tmp/sx /tmp/sa && echo "signals same"; grep "load after repair" /tmp/sx',
		(o) => ['hello', 'x86 rc 119', 'a64 rc 119', 'same', 'signals rc 143', 'signals same', 'load after repair 42'].every((l) => o.includes(l))
	],
	[
		'userland',
		'ifconfig lo 127.0.0.1 up; coreutils --coreutils-prog=factor 1234567 600851475143; ' +
			'coreutils --coreutils-prog=timeout 0.2 coreutils --coreutils-prog=sleep 5; echo "timeout rc $?"; ' +
			"bash -c 'x=$(echo sub); echo $x; (exit 7); echo \"subshell $?\"'; " +
			"sqlite3 :memory: 'with recursive c(x) as (select 1 union all select x+1 from c where x<10000) select count(*), sum(x), max(x), sum(x*x) % 1000003 from c;'; " +
			"echo filed > /tmp/f; curl -s file:///tmp/f; " +
			"{ printf 'HTTP/1.0 200 OK\\r\\n\\r\\nserved\\n' | nc -l -p 18083 > /dev/null; } & sleep 1; curl -s http://127.0.0.1:18083/; wait",
		(o) =>
			['1234567: 127 9721', '600851475143: 71 839 1471 6857', 'timeout rc 124', 'sub', 'subshell 7', '10000|50005000|10000|334854', 'filed', 'served'].every((l) =>
				o.includes(l)
			)
	],
	[
		'fork',
		'ifconfig lo 127.0.0.1 up; fork',
		(o) => o.includes('exec from a fork child') && passes(5)(o)
	],
	[
		'shell',
		"printf 'a\\nb\\nc\\n' > /tmp/rx; { read a; read b; echo \"group $a $b\"; } < /tmp/rx; while read l; do echo \"loop $l\"; done < /tmp/rx",
		(o) => ['group a b', 'loop a', 'loop b', 'loop c'].every((l) => o.includes(l))
	],
	[
		'dl',
		'dl',
		(o) =>
			['zlib 1.3.1', 'crc32 273b7535', 'compressed 639 bytes (rc 0), adler32 99df58be', 'round trip same (rc 0)'].every((l) => o.includes(l)) &&
			passes(5)(o)
	],
	['posix', 'ifconfig lo 127.0.0.1 up; mkdir -p /lua-tests; posix', passes(9)]
];
// fork needs resumable frames; PROT_NONE mappings take real memory without an MMU
const blocked = new Set(['ipc_sem', 'pthread_atfork-errno-clobber', 'pthread_exit-dtor', 'pthread_create-oom']);
const libcTests = (process.env.LIBC_TESTS ?? '').split(' ').filter(Boolean);
// ONLY="posix dl" runs just those
const only = (process.env.ONLY ?? '').split(' ').filter(Boolean);
const cases = [
	...probes.filter(([label]) => !only.length || only.includes(label)),
	...libcTests.map((t) => [t, `mkdir -p /dev/shm; ${t}; echo "RC $?"`, (o) => /^RC 0\r?$/m.test(o)])
];
let failed = 0;
let resets = 0;
let replaced = 0;
for (const [label, cmd, check] of cases) {
	let name = '';
	const get = async (path) =>
		(await fetch(`${B}${path}${path.includes('?') ? '&' : '?'}do=${name}`)).json().catch(() => ({}));
	// the platform can take a machine away without an exception: a boot landing in an isolate that
	// still holds an evicted machine's memory is reset, and a booted object can be replaced between
	// two requests. These probes take no checkpoint, so either loss is counted and the case rerun
	let out = '';
	for (let attempt = 0; attempt < 3; attempt++) {
		name = `suite-${label}-${Date.now()}`;
		await get('/burn?iters=3e8');
		// the amd64 userland needs room: every katybug image is one contiguous block without an MMU
		const boot = await get(`/boot?pages=${label === 'userland' ? 2400 : 1200}&wall=20000`);
		if (!boot.instance) {
			resets++;
			continue;
		}
		let lost = false;
		const step = async (path) => {
			const r = await get(path);
			if (r.instance !== boot.instance) lost = true;
			return r.out ?? '';
		};
		out = await step(`/exec?cmd=${encodeURIComponent(`${cmd}; echo END-$((1+1))`)}&wall=6000`);
		for (let i = 0; i < 12 && !lost && !out.includes('END-2'); i++) out += await step('/run?until=END-2&wall=5000');
		await get('/abort');
		if (!lost) break;
		replaced++;
		out = '';
	}
	const ok = check(out);
	const note = blocked.has(label) ? ' (known: needs fork or an MMU)' : '';
	if (!ok && !note) failed++;
	console.log(ok ? 'PASS' : 'FAIL', label.padEnd(34), ok ? '' : note || JSON.stringify(out.slice(-240)));
}
console.log(`machines lost to the platform: ${resets} boots reset, ${replaced} replaced after boot`);
process.exit(failed ? 1 : 0);
