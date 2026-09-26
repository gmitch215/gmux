// boot a machine, evict it, boot the same object again; does the new instance share the old
// one's isolate, and is its boot reset for memory? Runs against experiments/boot deployed.
// With reuse on, the successor boots into its predecessor's memory (worker.ts POOL).
// `node evicted.mjs [reps] [pages]`
const B = process.env.G08_URL ?? 'https://gmux-boot.gmitch215-free.workers.dev';
const reps = Number(process.argv[2] ?? 5), pages = Number(process.argv[3] ?? 2400);
const arms = [];
for (const reuse of [0, 1]) {
	for (const delay of [0, 30]) arms.push({ evict: 'abort', release: 0, delay, reuse });
	arms.push({ evict: 'idle', release: 0, delay: 75, reuse });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
for (let rep = 0; rep < reps; rep++)
	for (const arm of arms) {
		if (arm.evict === 'idle' && rep >= 2) continue;
		const name = `evicted-${Date.now()}`;
		const q = async (p) => {
			const r = await fetch(`${B}${p}${p.includes('?') ? '&' : '?'}do=${name}`);
			const text = await r.text();
			try { return { status: r.status, ...JSON.parse(text) }; } catch { return { status: r.status, body: text.slice(0, 40) }; }
		};
		await q('/burn?iters=3e8');
		const first = await q(`/boot?pages=${pages}&wall=20000`);
		if (arm.evict === 'abort') await q(`/abort?release=${arm.release}`).catch(() => {});
		await wait(arm.delay * 1000);
		const who = await q('/who');
		const second = await q(`/boot?pages=${pages}&wall=20000&reuse=${arm.reuse}`);
		console.log(JSON.stringify({
			...arm,
			firstOk: !!first.instance,
			sameIsolate: who.isolate === first.isolate,
			sameInstance: who.instance === first.instance,
			liveBefore: who.live,
			reset: second.status !== 200,
			booted: !!second.instance,
			prompt: /# $/.test(second.out ?? '')
		}));
		await q('/abort?release=1').catch(() => {});
	}
