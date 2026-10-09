import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { join } from 'node:path';
import { hostRuntime } from '../../../scripts/wasm/router-modules.ts';
import { Machine } from '../../../src/worker/machine/machine.ts';
import { siteOptions } from '../../../src/worker/site-machine.ts';

/**
 * Boots a machine, serves /www with BusyBox httpd and sends requests through `machine.ingress`.
 * MODE=raw prints each reply's raw bytes (Date masked) as a sha256 and writes the small ones under
 * OUT (NAMES=1k,post picks the requests); MODE=bench WORKLOAD=small|cgi|big|stream|catcgi|post ROUNDS=25
 * takes the crossing and CPU table; MODE=count WORKLOAD=... runs one request per round with every
 * guest syscall counted (not a timing); bench rounds skip the reply hash unless HASH=1 and write a V8 CPU
 * profile of the rounds to PROFILE; MODE=slow reads the big file at RATE bytes per second and
 * reports the guest's free memory; MODE=abort runs four requests and aborts one mid-body;
 * MODE=streams K=<n> WORKLOAD=static|cgi boots the site's own machine (its options, 800 pages), opens K
 * stalled readers of the big file and reports the guest's free memory once it stops moving.
 * `node --experimental-strip-types experiments/serving/scripts/serve.ts [kernel dir]`
 */
const root = new URL('../../../', import.meta.url).pathname;
const dir = process.argv[2] ?? join(root, 'build/kernel');
const mode = process.env.MODE ?? 'raw';
const out = process.env.OUT;
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
let output = '';
const syscallBytes: Record<number, number> = {};
// IMPORTS=1: the host time inside each of the kernel's plain (non-suspending) imports, by name
const importUs: Record<string, number> = {};
const importCalls: Record<string, number> = {};
if (process.env.IMPORTS === '1') {
	const Original = WebAssembly.Instance;
	(WebAssembly as any).Instance = class extends Original {
		constructor(module: WebAssembly.Module, imports?: WebAssembly.Imports) {
			const env = imports?.env as Record<string, unknown> | undefined;
			if (env && 'wasm_net_send' in env)
				for (const [name, fn] of Object.entries(env)) {
					if (typeof fn !== 'function') continue;
					importUs[name] = 0;
					importCalls[name] = 0;
					env[name] = (...args: unknown[]) => {
						const t0 = performance.now();
						try {
							return fn(...args);
						} finally {
							importUs[name] += (performance.now() - t0) * 1000;
							importCalls[name]++;
						}
					};
				}
			super(module, imports);
		}
	};
}
const kernelFile = (name: string) => readFileSync(join(dir, name));
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
// streams mode boots the machine the site runs; the others keep their own, smaller options
const siteMachine = () =>
	siteOptions(
		{
			vmlinux: new WebAssembly.Module(kernelFile('vmlinux.async.wasm')),
			busybox: new WebAssembly.Module(kernelFile('busybox.async.wasm')),
			busyboxGuard: new WebAssembly.Module(kernelFile('busybox.guard.wasm')),
			katybug: new WebAssembly.Module(kernelFile('katybug.wasm')),
			runtime: hostRuntime(),
			initrd: new Uint8Array(kernelFile('initramfs.bin')),
			manifest
		},
		{ sha256, write: (text) => void (output += text) }
	);
const machine = new Machine(mode === 'streams' ? siteMachine() : {
	...(mode === 'count'
		? {
				runtime: hostRuntime(),
				countSyscalls: (call: { nr: number; ret: number | null }) => {
					if (call.ret !== null && call.ret > 0)
						syscallBytes[call.nr] = (syscallBytes[call.nr] ?? 0) + call.ret;
				}
			}
		: {}),
	vmlinux: new WebAssembly.Module(readFileSync(join(dir, 'vmlinux.wasm'))),
	initrd: new Uint8Array(readFileSync(join(dir, 'initramfs.bin'))),
	cmdline: 'maxcpus=3 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0',
	registry: new Map([
		[manifest.busybox, new WebAssembly.Module(readFileSync(join(dir, 'busybox.wasm')))]
	]),
	maximumPages: Number(process.env.PAGES ?? 4096),
	sha256,
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
	hello: 'GET /cgi-bin/hello.cgi HTTP/1.1\r\nHost: serve\r\nConnection: close\r\n\r\n',
	// the big file through a CGI: httpd copies it with read and write where it sendfile()s a static file
	catcgi: 'GET /cgi-bin/cat.cgi HTTP/1.1\r\nHost: serve\r\nConnection: close\r\n\r\n'
};
// a 1 MiB body to a CGI that counts and discards it
const POST_BODY = Buffer.alloc(1 << 20, 'x');
const POST = Buffer.concat([
	Buffer.from(
		`POST /cgi-bin/sink.cgi HTTP/1.1\r\nHost: serve\r\nContent-Type: application/octet-stream\r\nContent-Length: ${POST_BODY.length}\r\nConnection: close\r\n\r\n`
	),
	POST_BODY
]);
const BODIES: Record<string, string | Uint8Array> = { ...REQUESTS, post: POST };
// WORKLOAD=ingest: BODY_MIB of body to the same CGI (SINK=store keeps it in RAM until the reply), written CHUNK bytes at a time as a request arrives
const INGEST_BYTES = Number(process.env.BODY_MIB ?? 1) * (1 << 20);
const INGEST_CHUNK = Number(process.env.CHUNK ?? 65_536);
const INGEST_BODY = Buffer.alloc(INGEST_BYTES, 'x');
const INGEST = [
	Buffer.from(
		`POST /cgi-bin/${process.env.SINK ?? 'sink'}.cgi HTTP/1.1\r\nHost: serve\r\nContent-Type: application/octet-stream\r\nContent-Length: ${INGEST_BYTES}\r\nConnection: close\r\n\r\n`
	),
	...Array.from({ length: Math.ceil(INGEST_BYTES / INGEST_CHUNK) }, (_, i) =>
		INGEST_BODY.subarray(i * INGEST_CHUNK, (i + 1) * INGEST_CHUNK)
	)
];

/** one request through the stream; the reply's head has its Date line masked before it is hashed */
async function rawWork(
	request: string | Uint8Array | Uint8Array[],
	onChunk?: (bytes: Uint8Array) => Promise<void>,
	hashed = true
) {
	const stream = machine.ingress(80);
	const hash = createHash('sha256');
	const kept: Uint8Array[] = [];
	let total = 0;
	let headDone = false;
	{
		{
			for (const part of Array.isArray(request) ? request : [request]) await stream.write(part);
			const reader = stream.readable.getReader();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				total += value.length;
				await onChunk?.(value);
				if (!hashed) continue;
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
const raw = (
	request: string | Uint8Array | Uint8Array[],
	onChunk?: (bytes: Uint8Array) => Promise<void>,
	hashed = true
) => drive(rawWork(request, onChunk, hashed));

// calls into the four net imports, counted at the host's table (the imports call these methods)
const net = (machine as unknown as { net: Record<string, (...args: any[]) => any> }).net;
const cross = {
	nextCalls: 0,
	nextEvents: 0,
	sendCalls: 0,
	sendOffered: 0,
	sendTaken: 0,
	sendZero: 0,
	endCalls: 0,
	listenCalls: 0,
	// time inside each import's host function, in microseconds (what the crossing and its copies cost)
	nextUs: 0,
	sendUs: 0,
	endUs: 0
};
for (const [name, count, us] of [
	[
		'next',
		(r: number) => {
			cross.nextCalls++;
			cross.nextEvents += r;
		},
		(t: number) => (cross.nextUs += t)
	],
	['end', () => cross.endCalls++, (t: number) => (cross.endUs += t)],
	['listen', () => cross.listenCalls++, () => 0]
] as const) {
	const original = net[name]!.bind(net);
	net[name] = (...args) => {
		const t0 = performance.now();
		const result = original(...args);
		us((performance.now() - t0) * 1000);
		count(result);
		return result;
	};
}
const sendOriginal = net.send!.bind(net);
net.send = (id: number, bytes: Uint8Array) => {
	const t0 = performance.now();
	const result = sendOriginal(id, bytes);
	cross.sendUs += (performance.now() - t0) * 1000;
	cross.sendCalls++;
	cross.sendOffered += bytes.length;
	if (result > 0) cross.sendTaken += result;
	else if (result === 0) cross.sendZero++;
	return result;
};
const crossNow = () => ({ ...cross });
const crossDiff = (a: typeof cross, b: typeof cross) =>
	Object.fromEntries(Object.keys(cross).map((k) => [k, (b as any)[k] - (a as any)[k]]));
// syscalls by number (mode count): calls, and the bytes the calls that returned a count moved
const sysNow = () => ({ calls: { ...machine.stats.syscalls }, bytes: { ...syscallBytes } });
const sysDiff = (a: ReturnType<typeof sysNow>, b: ReturnType<typeof sysNow>) => ({
	calls: Object.fromEntries(
		Object.entries(b.calls)
			.map(([nr, n]) => [nr, n - (a.calls[Number(nr)] ?? 0)])
			.filter(([, n]) => n)
	),
	bytes: Object.fromEntries(
		Object.entries(b.bytes)
			.map(([nr, n]) => [nr, n - (a.bytes[Number(nr)] ?? 0)])
			.filter(([, n]) => n)
	)
});

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
const freeBoot = mode === 'streams' ? await memFree() : 0;
await sh('mkdir -p /www/cgi-bin');
await sh('seq 1 400 | head -c 1024 > /www/1k.txt; seq 1 1000000 > /www/big.txt');
await sh(
	`printf '#!/bin/sh\\necho "Content-Type: text/plain"\\necho\\necho hello\\n' > /www/cgi-bin/hello.cgi; ` +
		`printf '#!/bin/sh\\necho "Content-Type: text/plain"\\necho\\nseq 1 3000000\\n' > /www/cgi-bin/stream.cgi; ` +
		`printf '#!/bin/sh\\necho "Content-Type: text/plain"\\necho\\necho got $(wc -c)\\n' > /www/cgi-bin/sink.cgi; ` +
		`printf '#!/bin/sh\\necho "Content-Type: text/plain"\\necho\\ncat /www/big.txt\\n' > /www/cgi-bin/cat.cgi; ` +
		// the body kept in the guest's RAM until the reply, as a program that stores an upload does
		`printf '#!/bin/sh\\necho "Content-Type: text/plain"\\necho\\ncat > /tmp/up; echo got $(wc -c < /tmp/up); rm /tmp/up\\n' > /www/cgi-bin/store.cgi; ` +
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
	const names = process.env.NAMES?.split(',') ?? ['1k', '404', 'head', 'range', 'big', 'cgi'];
	for (const name of names) {
		const before = stat();
		const t0 = performance.now();
		const reply = await raw(BODIES[name]!);
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
} else if (mode === 'bench' || mode === 'count') {
	const name = process.env.WORKLOAD ?? 'small';
	const request = {
		small: SMALL,
		cgi: REQUESTS.hello!,
		big: REQUESTS.big!,
		stream: REQUESTS.cgi!,
		catcgi: REQUESTS.catcgi!,
		post: POST,
		ingest: INGEST
	}[name]!;
	// the warm-up request is hashed (the sample's exactness check); the rounds are not unless HASH=1,
	// which is what the first table's rig did (a sha256 over the reply inside the timed region)
	const hashRounds = process.env.HASH === '1';
	let sinkText = '';
	const warm = await raw(
		request,
		name === 'ingest'
			? async (chunk) => void (sinkText += Buffer.from(chunk).toString('latin1'))
			: undefined
	);
	const rounds = Number(process.env.ROUNDS ?? (mode === 'count' ? 1 : 25));
	const rows = [];
	const hashes = new Set<string>([warm.sha256]);
	let sys: ReturnType<typeof sysDiff> | undefined;
	const importsBefore = { us: { ...importUs }, calls: { ...importCalls } };
	// PROFILE=<file> writes a V8 CPU profile of the rounds alone
	const profiler = process.env.PROFILE ? new Session() : undefined;
	if (profiler) {
		profiler.connect();
		await profiler.post('Profiler.enable');
		await profiler.post('Profiler.setSamplingInterval', { interval: 100 });
		await profiler.post('Profiler.start');
	}
	for (let i = 0; i < rounds; i++) {
		const before = stat();
		const crossBefore = crossNow();
		const sysBefore = sysNow();
		const stepsBefore = steps;
		const cpu = process.cpuUsage();
		const t0 = performance.now();
		const reply = await raw(request, undefined, hashRounds);
		const used = process.cpuUsage(cpu);
		if (hashRounds) hashes.add(reply.sha256);
		else if (reply.bytes !== warm.bytes) hashes.add('bytes differ');
		if (mode === 'count') sys = sysDiff(sysBefore, sysNow());
		rows.push({
			bytes: reply.bytes,
			wallMs: performance.now() - t0,
			cpuMs: (used.user + used.system) / 1000,
			steps: steps - stepsBefore,
			...diff(before, stat()),
			...crossDiff(crossBefore, crossNow())
		});
	}
	if (profiler) {
		const { profile } = await profiler.post('Profiler.stop');
		writeFileSync(process.env.PROFILE!, JSON.stringify(profile));
	}
	const mean = (key: string) => rows.reduce((n, r) => n + (r as any)[key], 0) / rows.length;
	const spread = (key: string) => {
		const v = rows.map((r) => (r as any)[key] as number).sort((a, b) => a - b);
		return [v[0], v[Math.floor(v.length / 2)], v.at(-1)];
	};
	const crossKeys = Object.keys(cross);
	// the copy alone: a slice of the machine's memory the size of a mean send, as `send` makes one
	const probe = new Uint8Array(machine.memory.buffer, 0, 11_393);
	const copyStart = performance.now();
	for (let i = 0; i < 20_000; i++) probe.slice(0, probe.length);
	const copyUs = ((performance.now() - copyStart) * 1000) / 20_000;
	console.log(
		JSON.stringify({
			mode,
			workload: name,
			...(name === 'ingest'
				? {
						bodyBytes: INGEST_BYTES,
						chunk: INGEST_CHUNK,
						sinkCounted: sinkText.includes(`got ${INGEST_BYTES}`)
					}
				: {}),
			rounds,
			bytes: rows[0]!.bytes,
			sha256: hashes.size === 1 ? [...hashes][0] : 'mixed',
			hashed: hashRounds,
			crashed: String(machine.crashed),
			cpuMs: { mean: +mean('cpuMs').toFixed(3), minMedianMax: spread('cpuMs') },
			wallMs: { mean: +mean('wallMs').toFixed(3), minMedianMax: spread('wallMs') },
			steps: { mean: +mean('steps').toFixed(1), minMedianMax: spread('steps') },
			perRequest: Object.fromEntries(
				[...counters, ...crossKeys].map((k) => [k, +mean(k).toFixed(1)])
			),
			// bytes per crossing: out per send offered and per send that took bytes, in per event
			bytesPerSend: +(mean('netBytesOut') / mean('sendCalls')).toFixed(1),
			copyUsPer11KiB: +copyUs.toFixed(3),
			...(process.env.IMPORTS === '1'
				? {
						importsPerRequest: Object.fromEntries(
							Object.keys(importUs)
								.map((name) => [
									name,
									{
										us: +((importUs[name]! - importsBefore.us[name]!) / rounds).toFixed(1),
										calls: +((importCalls[name]! - importsBefore.calls[name]!) / rounds).toFixed(1)
									}
								] as const)
								.filter(([, v]) => v.calls > 0)
								.sort((a, b) => b[1].us - a[1].us)
								.slice(0, 14)
						)
					}
				: {}),
			bytesPerNextEvent: +(mean('netBytesIn') / Math.max(mean('nextEvents'), 1)).toFixed(1),
			...(sys ? { syscalls: sys } : {})
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
} else if (mode === 'streams') {
	const k = Number(process.env.K ?? 1);
	const settleMs = Number(process.env.SETTLE_MS ?? 4000);
	const request = process.env.WORKLOAD === 'cgi' ? REQUESTS.catcgi! : REQUESTS.big!;
	const oomText = () =>
		/out of memory|oom-kill|invoked oom-killer|killed process/i.exec(output)?.[0] ?? null;
	const taskCount = async () =>
		Number(/tasks=(\d+)/.exec(await sh("echo tasks=$(ls /proc | grep -c '^[0-9]')"))?.[1]);
	const tasks0 = await taskCount();
	const readers = Array.from({ length: k }, () => {
		const stream = machine.ingress(80);
		const state = { first: '', bytes: 0, error: '' };
		// one read, then the reader stalls with the rest of the reply queued in the guest
		const first = (async () => {
			await stream.write(request);
			const { value } = await stream.readable.getReader().read();
			state.bytes = value?.length ?? 0;
			state.first = Buffer.from(value ?? []).toString('latin1').split('\r\n')[0]!;
		})().catch((error) => void (state.error = String(error)));
		return { stream, state, first };
	});
	let arrived = true;
	await drive(Promise.all(readers.map((r) => r.first)), 120_000).catch(() => (arrived = false));
	// null when the shell cannot start grep (no task left, or the OOM killer took it)
	const tryFree = async () =>
		Number(/MemFree:\s+(\d+)/.exec(await sh('grep MemFree /proc/meminfo'))?.[1]) || null;
	const samples: number[] = [];
	let shellDead = false;
	for (let i = 0; i < 12 && !shellDead; i++) {
		await drive(new Promise((r) => setTimeout(r, settleMs)), 120_000);
		const free = await tryFree();
		if (free === null) shellDead = true;
		else samples.push(free);
		const last = samples.slice(-3);
		if (last.length === 3 && Math.max(...last) - Math.min(...last) <= 64) break;
	}
	const states = readers.map((r) => r.state);
	const report = {
		mode,
		kernel: dir,
		workload: process.env.WORKLOAD ?? 'static',
		k,
		freeBoot,
		free0,
		freeSamples: samples,
		freeSteady: samples.at(-1),
		perStreamKb: k && samples.length ? +((free0 - samples.at(-1)!) / k).toFixed(1) : 0,
		tasks0,
		tasks: shellDead ? null : await taskCount(),
		shellDead,
		...(shellDead ? { consoleTail: output.slice(-600) } : {}),
		allArrived: arrived,
		ok: states.filter((s) => s.first.startsWith('HTTP/1.1 200')).length,
		statuses: [...new Set(states.map((s) => s.first || s.error))],
		openStreams: machine.openStreams,
		oom: oomText()
	};
	for (const r of readers) r.stream.abort();
	await drive(new Promise((r) => setTimeout(r, settleMs)), 120_000);
	console.log(
		JSON.stringify({
			...report,
			freeAfterAbort: await tryFree(),
			tasksAfter: shellDead ? null : await taskCount()
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
