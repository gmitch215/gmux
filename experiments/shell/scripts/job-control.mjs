// on a deployed machine: pipes, a blocked reader, ^C, a busy loop, background jobs; one fresh machine per case
const B = process.env.G08_URL ?? 'https://gmux-boot.gmitch215-free.workers.dev';
const cases = [
	['pipe', 'yes | head -1; echo END-$((1+1))', (o) => /\ny\r?\n/.test(o)],
	['blocked reader woken by a writer', '(sleep 1; echo woke) | cat; echo END-$((1+1))', (o) => o.includes('woke')],
	['^C to a foreground job', 'sleep 30', null, '\x03', 'echo END-$((1+1))'],
	['busy loop, then ^C', 'while true; do :; done', null, '\x03', 'echo END-$((1+1))'],
	['background job and wait', 'sleep 1 & wait; echo END-$((1+1))', (o) => o.includes('Done') || o.includes('END-2')]
];
for (const [label, cmd, check, key, after] of cases) {
	const name = `shell-${Date.now()}`;
	const get = async (path) => {
		const res = await fetch(`${B}${path}${path.includes('?') ? '&' : '?'}do=${name}`);
		try {
			return await res.json();
		} catch {
			return {};
		}
	};
	await get('/burn?iters=3e8');
	await get('/boot?pages=800&wall=20000');
	let out = (await get(`/exec?cmd=${encodeURIComponent(cmd)}&wall=4000`)).out ?? '';
	if (key) {
		await get(`/run?wall=2000`);
		out += (await get(`/exec?cmd=${encodeURIComponent(key)}&wall=3000`)).out ?? '';
		out += (await get(`/exec?cmd=${encodeURIComponent(after)}&wall=6000`)).out ?? '';
	}
	let crashed = false;
	for (let i = 0; i < 8 && !out.includes('END-2') && !crashed; i++) {
		const r = await get('/run?until=END-2&wall=5000');
		out += r.out ?? '';
		crashed = r.outcome === 'crashed';
	}
	const ok = out.includes('END-2') && !crashed && (!check || check(out));
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(34)} ${crashed ? 'crashed' : ''} ${ok ? '' : JSON.stringify(out.slice(-140))}`);
}
process.exit(0);
