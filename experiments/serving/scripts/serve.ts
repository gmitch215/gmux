import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Machine } from '../../../src/worker/machine/machine.ts';

/**
 * Boots a machine, serves /www with BusyBox httpd and sends requests through `machine.ingress`.
 * MODE=raw prints each reply's raw bytes (Date masked) as a sha256 and writes the small ones under
 * OUT; MODE=bench WORKLOAD=small|cgi|big ROUNDS=25 takes the host-call and CPU table; MODE=slow
 * reads the big file at RATE bytes per second and reports the guest's free memory; MODE=abort runs
 * four requests and aborts one mid-body.
 * `node --experimental-strip-types experiments/serving/scripts/serve.ts [kernel dir]`
 */
const root = new URL('../../../', import.meta.url).pathname;
const dir = process.argv[2] ?? join(root, 'build/kernel');
const mode = process.env.MODE ?? 'raw';
const out = process.env.OUT;
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
let output = '';
const machine = new Machine({
	vmlinux: new WebAssembly.Module(readFileSync(join(dir, 'vmlinux.wasm'))),
	initrd: new Uint8Array(readFileSync(join(dir, 'initramfs.bin'))),
	cmdline: 'maxcpus=3 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0',
	registry: new Map([
		[manifest.busybox, new WebAssembly.Module(readFileSync(join(dir, 'busybox.wasm')))]
	]),
	maximumPages: Number(process.env.PAGES ?? 4096),
	sha256: (bytes) => createHash('sha256').update(bytes).digest('hex'),
	sharedKernel: true,
	write: (text) => (output += text)
});
let steps = 0;
// yields to timers without waiting out the machine's own: an idle machine reaches its next timer
const sleep = () => new Promise<void>((r) => setImmediate(r));

/** runs the machine until `work` settles */
async function drive<T>(work: Promise<T>, limitMs = 900_000): Promise<T> {
	let finished = false;
	const result = work.finally(() => (finished = true));
	// a rejection is returned below; until then it is not unhandled
	result.catch(() => {});
	const started = Date.now();
	const trace = process.env.TRACE
		? setInterval(() => console.log('trace', steps, JSON.stringify(pickStats())), 2000)
		: undefined;
	await machine.run(() => (steps++, finished || Date.now() - started > limitMs), sleep);
	clearInterval(trace);
	if (!finished) throw new Error('the work did not finish in time');
	return result;
}

async function sh(command: string) {
	const mark = `done${Math.floor(Math.random() * 1e6)}`;
	const from = output.length;
	let seen = false;
	machine.type(`${command}; echo ${mark.slice(0, 4)}=${mark.slice(4)}-$?\n`);
	const want = new RegExp(`${mark.slice(0, 4)}=${mark.slice(4)}-\\d`);
	let finished = false;
	await machine.run(() => (steps++, (seen = want.test(output.slice(from))), seen), sleep);
	void finished;
	return output.slice(from).replace(/\r/g, '');
}

const SMALL = 'GET /1k.txt HTTP/1.1\r\nHost: serve\r\nConnection: close\r\n\r\n';
const REQUESTS: Record<string, string> = {
	'1k': SMALL,
	'404': 'GET /nope HTTP/1.1\r\nHost: serve\r\nConnection: close\r\n\r\n',
	head: 'HEAD /1k.txt HTTP/1.1\r\nHost: serve\r\nConnection: close\r\n\r\n',
	range: 'GET /1k.txt HTTP/1.1\r\nHost: serve\r\nRange: bytes=100-199\r\nConnection: close\r\n\r\n',
	big: 'GET /big.txt HTTP/1.1\r\nHost: serve\r\nConnection: close\r\n\r\n',
	cgi: 'GET /cgi-bin/stream.cgi HTTP/1.1\r\nHost: serve\r\nConnection: close\r\n\r\n',
	hello: 'GET /cgi-bin/hello.cgi HTTP/1.1\r\nHost: serve\r\nConnection: close\r\n\r\n'
};

/** one request through the stream; the reply's head has its Date line masked before it is hashed */
async function rawWork(request: string, onChunk?: (bytes: Uint8Array) => Promise<void>) {
	const stream = machine.ingress(80);
	const hash = createHash('sha256');
	const kept: Uint8Array[] = [];
	let total = 0;
	let headDone = false;
	{
		{
			await stream.write(request);
			const reader = stream.readable.getReader();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				total += value.length;
				await onChunk?.(value);
				// the Date line is in the first chunk; every other byte is hashed as it came
				let chunk = value;
				if (!headDone) {
					headDone = true;
					const text = Buffer.from(value).toString('latin1');
					// the file's mtime and inode differ between the two machines, and so do these lines
					const masked = text.replace(/^(Date|Last-Modified|ETag): .*\r$/gm, '$1: MASKED\r');
					chunk = Buffer.from(masked, 'latin1');
				}
				hash.update(chunk);
				if (out && total < 1 << 20) kept.push(chunk);
			}
			stream.end();
		}
	}
	return { bytes: total, sha256: hash.digest('hex'), body: out ? Buffer.concat(kept) : undefined };
}
const raw = (request: string, onChunk?: (bytes: Uint8Array) => Promise<void>) =>
	drive(rawWork(request, onChunk));

const stat = () => ({ ...machine.stats });
const counters = [
	'switches',
	'idles',
	'userCopies',
	'userStrings',
	'touchedPages',
	'netOpens',
	'netEvents',
	'netSends',
	'netBytesIn',
	'netBytesOut',
	'netBackpressure'
] as const;
const diff = (a: ReturnType<typeof stat>, b: ReturnType<typeof stat>) =>
	Object.fromEntries(counters.map((k) => [k, Number(b[k]) - Number(a[k])]));
const memFree = async () => Number(/MemFree:\s+(\d+)/.exec(await sh('grep MemFree /proc/meminfo'))![1]);

// #region setup
await drive(
	(async () => {
		while (!output.includes('# ')) await sleep();
	})()
);
if (process.env.BOOT) console.log(output.split('\n').slice(-25).join('\n'));
await sh('mkdir -p /www/cgi-bin');
await sh('seq 1 400 | head -c 1024 > /www/1k.txt; seq 1 1000000 > /www/big.txt');
await sh(
	`printf '#!/bin/sh\\necho "Content-Type: text/plain"\\necho\\necho hello\\n' > /www/cgi-bin/hello.cgi; ` +
		`printf '#!/bin/sh\\necho "Content-Type: text/plain"\\necho\\nseq 1 3000000\\n' > /www/cgi-bin/stream.cgi; ` +
		'chmod +x /www/cgi-bin/*.cgi'
);
const listeningBefore = machine.listening(80);
const started = await sh('httpd -p 80 -h /www; echo httpd=$?');
await sh('sleep 1');
const free0 = await memFree();
console.log(
	JSON.stringify({ mode, kernel: dir, listeningBefore, listening: machine.listening(80), free0, started: started.includes('httpd=0') })
);
// #endregion

if (mode === 'raw') {
	if (out) mkdirSync(out, { recursive: true });
	for (const name of ['1k', '404', 'head', 'range', 'big', 'cgi'] as const) {
		const before = stat();
		const t0 = performance.now();
		const reply = await raw(REQUESTS[name]!);
		if (out && reply.body) writeFileSync(join(out, `${name}.raw`), reply.body);
		console.log(
			JSON.stringify({
				name,
				bytes: reply.bytes,
				sha256: reply.sha256,
				ms: +(performance.now() - t0).toFixed(1),
				...diff(before, stat())
			})
		);
	}
} else if (mode === 'bench') {
	const name = process.env.WORKLOAD ?? 'small';
	const request = { small: SMALL, cgi: REQUESTS.hello!, big: REQUESTS.big! }[name]!;
	await raw(request);
	const rounds = Number(process.env.ROUNDS ?? 25);
	const rows = [];
	for (let i = 0; i < rounds; i++) {
		const before = stat();
		const stepsBefore = steps;
		const cpu = process.cpuUsage();
		const t0 = performance.now();
		const reply = await raw(request);
		const used = process.cpuUsage(cpu);
		rows.push({
			bytes: reply.bytes,
			wallMs: performance.now() - t0,
			cpuMs: (used.user + used.system) / 1000,
			steps: steps - stepsBefore,
			...diff(before, stat())
		});
	}
	const mean = (key: string) => rows.reduce((n, r) => n + (r as any)[key], 0) / rows.length;
	const spread = (key: string) => {
		const v = rows.map((r) => (r as any)[key] as number).sort((a, b) => a - b);
		return [v[0], v[Math.floor(v.length / 2)], v.at(-1)];
	};
	console.log(
		JSON.stringify({
			workload: name,
			rounds,
			bytes: rows[0]!.bytes,
			cpuMs: { mean: +mean('cpuMs').toFixed(3), minMedianMax: spread('cpuMs') },
			wallMs: { mean: +mean('wallMs').toFixed(3), minMedianMax: spread('wallMs') },
			steps: { mean: +mean('steps').toFixed(1), minMedianMax: spread('steps') },
			perRequest: Object.fromEntries(counters.map((k) => [k, +mean(k).toFixed(1)]))
		})
	);
} else if (mode === 'slow') {
	const rate = Number(process.env.RATE ?? 65_536);
	const floor = Number(process.env.FLOOR_KB ?? 4096);
	const lows: number[] = [];
	const slowStart = Date.now();
	let probing = false;
	let sampled = 0;
	let nextAt = 0;
	const free: number[] = [];
	const reply = await raw(REQUESTS.big!, async (chunk) => {
		const wait = (chunk.length / rate) * 1000;
		await new Promise((r) => setTimeout(r, wait));
		// every few seconds of reading, ask the guest how much memory it has free
		if (!probing && Date.now() >= nextAt) {
			probing = true;
			nextAt = Date.now() + 10_000;
			sampled++;
			free.push(await memFree());
			probing = false;
		}
	}).catch((error) => ({
		error: `${String(error)} after ${Date.now() - slowStart} ms`,
		bytes: 0,
		sha256: ''
	}));
	void lows;
	console.log(
		JSON.stringify({
			mode,
			rate,
			bytes: reply.bytes,
			sha256: reply.sha256,
			sampled,
			freeKbBefore: free0,
			freeKbMin: Math.min(...free),
			freeKbSamples: free,
			floorKb: floor,
			aboveFloor: Math.min(...free) > floor,
			...('error' in reply ? { error: reply.error } : {})
		})
	);
} else if (mode === 'abort') {
	const results: Record<string, unknown> = {};
	const aborted = machine.ingress(80);
	const [, ...others] = await drive(
		Promise.all([
			(async () => {
				await aborted.write(REQUESTS.big!);
				const reader = aborted.readable.getReader();
				let n = 0;
				while (n < 200_000) {
					const { done, value } = await reader.read();
					if (done) break;
					n += value.length;
				}
				aborted.abort();
				results.abortedAfter = n;
			})(),
			...['1k', 'big', 'cgi'].map(async (name) => ({
				name,
				...(await rawWork(REQUESTS[name]!))
			}))
		])
	);
	await drive(new Promise((r) => setTimeout(r, 200)));
	console.log(
		JSON.stringify({
			mode,
			...results,
			others: others.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })),
			openStreams: machine.openStreams,
			after: (await raw(REQUESTS['1k']!)).sha256,
			openAfter: await drive(
				new Promise<number>((r) => setTimeout(() => r(machine.openStreams), 200))
			)
		})
	);
}
console.log(JSON.stringify({ crashed: String(machine.crashed), stats: pickStats() }));
function pickStats() {
	const s = machine.stats;
	return {
		netOpens: s.netOpens,
		netEvents: s.netEvents,
		netSends: s.netSends,
		netBytesIn: s.netBytesIn,
		netBytesOut: s.netBytesOut,
		netBackpressure: s.netBackpressure
	};
}
process.exit(0);
