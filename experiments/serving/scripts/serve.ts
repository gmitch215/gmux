import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendCpio } from '../../../scripts/wasm/cpio-append.ts';
import { hostRuntime } from '../../../scripts/wasm/router-modules.ts';
import { DurableStore, encodeSnapshot } from '../../../src/worker/durable.ts';
import { checkpointCost } from '../../../src/worker/keeper.ts';
import { requestBytes, responseFrom } from '../../../src/worker/machine/http.ts';
import { Machine } from '../../../src/worker/machine/machine.ts';
import { Cadence } from '../../../src/worker/schedule.ts';
import { Server } from '../../../src/worker/serve.ts';
import { siteOptions } from '../../../src/worker/site-machine.ts';
import { imports, watchKernel } from '../../syscall-cost/scripts/imports.ts';
import { sqlite } from '../../write-back/scripts/sqlite.ts';

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
 * SITE=1 (MODE=bench) runs the site's own machine and adds its boot, counters and one checkpoint to the report;
 * KERNELURL=1 records the kernel module's profile url, BOOTPROF=<file> profiles the boot, PERSIST=1 writes the
 * checkpoint (composed.ts in experiments/syscall-cost reads the profiles).
 * BUSYBOX=share (MODE=streams) registers busybox.share.wasm in the site's place, so execs reuse instances.
 * SERVER=lighttpd serves /www with lighttpd (LIGHTTPD_PLAIN as the census built it, LIGHTTPD the same
 * through scripts/wasm/instrument.sh; WORK keeps the generated initramfs) instead of httpd.
 * MODE=bench SHAPE=seq|keepalive|conc (K=<n> for conc) makes a round PER_ROUND (100) requests of the
 * small file on new streams one after another, down one keep-alive stream, or K at a time; the table
 * is per request.
 * `node --experimental-strip-types experiments/serving/scripts/serve.ts [kernel dir]`
 */
const root = new URL('../../../', import.meta.url).pathname;
const dir = process.argv[2] ?? join(root, 'build/kernel');
const mode = process.env.MODE ?? 'raw';
// BORROW=1: the raw streams let the kernel lend its buffers (kernel patch 0041); the readers recycle after each chunk
const borrow = process.env.BORROW === '1';
const out = process.env.OUT;
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
let output = '';
const syscallBytes: Record<number, number> = {};
// IMPORTS=1: the host time inside each of the kernel's plain (non-suspending) imports, by name
// (KERNELURL=1 only records the kernel module's url in a V8 profile)
const importUs = imports.us;
const importCalls = imports.calls;
if (process.env.IMPORTS === '1' || process.env.KERNELURL === '1')
	watchKernel(process.env.IMPORTS === '1');
const kernelFile = (name: string) => readFileSync(join(dir, name));
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const lighttpd = process.env.SERVER === 'lighttpd';
const lighttpdConf = 'server.document-root = "/www"\nserver.port = 80\nserver.bind = "127.0.0.1"\n';
// the program's hash is of the file the guest reads; the machine runs the instrumented build in its place
const extraPrograms: [string, WebAssembly.Module][] = [];
let initramfs = new Uint8Array(kernelFile('initramfs.bin'));
if (lighttpd) {
	const plain = process.env.LIGHTTPD_PLAIN;
	const run = process.env.LIGHTTPD;
	if (!plain || !run) throw new Error('SERVER=lighttpd needs LIGHTTPD_PLAIN and LIGHTTPD');
	const work = process.env.WORK ?? join(tmpdir(), 'gmux-serve');
	mkdirSync(work, { recursive: true });
	const conf = join(work, 'lighttpd.conf');
	writeFileSync(conf, lighttpdConf);
	const key = sha256(
		Buffer.concat([kernelFile('initramfs.bin'), readFileSync(plain), Buffer.from(lighttpdConf)])
	).slice(0, 16);
	const cpio = join(work, `initramfs-lighttpd-${key}.cpio`);
	if (!existsSync(cpio))
		appendCpio(join(dir, 'initramfs.bin'), cpio, [`/bin/lighttpd=${plain}`, `/etc/lighttpd.conf=${conf}`]);
	initramfs = new Uint8Array(readFileSync(cpio));
	extraPrograms.push([sha256(readFileSync(plain)), new WebAssembly.Module(readFileSync(run))]);
}
// SITE=1 (bench) and streams mode boot the machine the site runs, with a file sync handler over a SQLite
// stand-in as the keeper's; the others keep their own, smaller options
const site = process.env.SITE === '1';
const syncs = { calls: 0, ms: 0 };
const store = site ? new DurableStore(sqlite()) : undefined;
const siteMachine = () => {
	const options = siteOptions(
		{
			vmlinux: new WebAssembly.Module(kernelFile('vmlinux.async.wasm')),
			busybox: new WebAssembly.Module(kernelFile('busybox.async.wasm')),
			busyboxGuard: new WebAssembly.Module(kernelFile('busybox.guard.wasm')),
			busyboxShare:
				process.env.BUSYBOX === 'share'
					? new WebAssembly.Module(kernelFile('busybox.share.wasm'))
					: undefined,
			katybug: new WebAssembly.Module(kernelFile('katybug.wasm')),
			runtime: hostRuntime(),
			initrd: initramfs,
			manifest
		},
		{ sha256, write: (text) => void (output += text) }
	);
	for (const [hash, module] of extraPrograms) options.registry!.set(hash, module);
	if (site)
		options.fileSync = async (file) => {
			const t0 = performance.now();
			store!.writeFile(file);
			syncs.calls++;
			syncs.ms += performance.now() - t0;
		};
	return options;
};
// the modules compile here, as a Worker's do at startup, before the boot is timed
const siteOpts = mode === 'streams' || site ? siteMachine() : undefined;
// BOOTPROF=<file> writes a V8 CPU profile of the boot alone, machine creation to the console prompt
const bootProf = process.env.BOOTPROF ? new Session() : undefined;
if (bootProf) {
	bootProf.connect();
	await bootProf.post('Profiler.enable');
	await bootProf.post('Profiler.setSamplingInterval', { interval: 100 });
	await bootProf.post('Profiler.start');
}
const bootStart = performance.now();
const bootCpu = process.cpuUsage();
const machine = new Machine(siteOpts ?? {
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
	initrd: initramfs,
	cmdline: 'maxcpus=3 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0',
	registry: new Map([
		[manifest.busybox, new WebAssembly.Module(readFileSync(join(dir, 'busybox.wasm')))],
		...extraPrograms
	]),
	maximumPages: Number(process.env.PAGES ?? 4096),
	sha256,
	sharedKernel: true,
	write: (text) => (output += text)
});
let steps = 0;
// yields to timers without waiting out the machine's own: an idle machine reaches its next timer
// REAL_TIME=1 waits out the machine's timers as the site does, so guest time moves with the wall clock; the
// slow reader needs it (REAL_TIME=0 shows what skipping does: the guest's TCP gives up on a stalled peer)
const realTime = (process.env.REAL_TIME ?? (mode === 'slow' ? '1' : '0')) === '1';
const sleep = (ms = 0) =>
	new Promise<void>((r) => (realTime && ms > 0 ? void setTimeout(r, ms) : void setImmediate(r)));

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
	const stream = machine.ingress(80, borrow);
	const hash = createHash('sha256');
	const kept: Uint8Array[] = [];
	let total = 0;
	let headDone = false;
	{
		{
			for (const part of Array.isArray(request) ? request : [request]) await stream.write(part);
			const reader = stream.readable.getReader();
			for (;;) {
				// every chunk read so far has been used by here
				stream.recycle();
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
				if (out && total < 1 << 20) kept.push(chunk.slice());
			}
			stream.releaseAll();
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

const KEEP_ALIVE = 'GET /1k.txt HTTP/1.1\r\nHost: serve\r\nConnection: keep-alive\r\n\r\n';
/**
 * `count` requests down one stream, each written once the last reply's body has ended; stops where
 * the stream does (a server that closes after a reply serves one)
 */
async function keepAliveWork(count: number) {
	const stream = machine.ingress(80);
	const reader = stream.readable.getReader();
	let served = 0;
	let bytes = 0;
	let held = Buffer.alloc(0);
	while (served < count) {
		try {
			await stream.write(KEEP_ALIVE);
		} catch {
			break;
		}
		let need = -1;
		let closed = false;
		for (;;) {
			const end = need < 0 ? held.indexOf('\r\n\r\n') : -2;
			if (end >= 0) {
				const length = /^content-length: *(\d+)/im.exec(held.subarray(0, end).toString('latin1'));
				need = end + 4 + Number(length?.[1] ?? 0);
			}
			if (need >= 0 && held.length >= need) break;
			const { done, value } = await reader.read();
			if (done) {
				closed = true;
				break;
			}
			held = Buffer.concat([held, value]);
		}
		if (closed) break;
		served++;
		bytes += need;
		held = held.subarray(need);
	}
	stream.end();
	for (;;) if ((await reader.read().catch(() => ({ done: true }))).done) break;
	return { bytes, served };
}

/** one round of a SHAPE: perRound requests of the small file */
async function shapedRound(shape: string, perRound: number, workers: number) {
	if (shape === 'keepalive') return keepAliveWork(perRound);
	let bytes = 0;
	let next = 0;
	const worker = async () => {
		while (next < perRound) {
			next++;
			const reply = await rawWork(SMALL, undefined, false);
			bytes += reply.bytes;
		}
	};
	await Promise.all(Array.from({ length: shape === 'conc' ? workers : 1 }, worker));
	return { bytes, served: perRound };
}

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
// SEND_ARM=view|drop|slab: view enqueues the guest's own bytes uncopied (the reader may see them overwritten)
// and drop discards them, both ceilings and not exact; slab copies into a shared slab and stays exact
const sendArm = process.env.SEND_ARM;
const slabBytes = Number(process.env.SLAB_KIB ?? 256) * 1024;
let slab = new Uint8Array(0);
let slabAt = 0;
const sendOriginal =
	sendArm === 'view' || sendArm === 'drop' || sendArm === 'slab'
		? (id: number, bytes: Uint8Array) => {
				const table = net as unknown as {
					streams: Map<number, any>;
					stats: Record<string, number>;
					activity: number;
				};
				const stream = table.streams.get(id);
				if (!stream || stream.readClosed) return -1;
				table.stats.netSends!++;
				if (sendArm === 'drop') {
					table.stats.netBytesOut! += bytes.length;
					table.activity++;
					return bytes.length;
				}
				const room = Math.max(stream.controller.desiredSize ?? 0, 0);
				const n = Math.min(room, bytes.length);
				if (n < bytes.length) {
					stream.starved = true;
					table.stats.netBackpressure!++;
				}
				if (!n) return 0;
				if (sendArm === 'slab') {
					if (slabAt + n > slab.length) {
						slab = new Uint8Array(Math.max(slabBytes, n));
						slabAt = 0;
					}
					const out = slab.subarray(slabAt, slabAt + n);
					out.set(bytes.subarray(0, n));
					slabAt += n;
					stream.controller.enqueue(out);
				} else stream.controller.enqueue(bytes.subarray(0, n));
				table.stats.netBytesOut! += n;
				table.activity++;
				return n;
			}
		: net.send!.bind(net);
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
const lendOriginal = net.lend!.bind(net);
net.lend = (memory: WebAssembly.Memory, id: number, buf: number, n: number) => {
	const t0 = performance.now();
	const result = lendOriginal(memory, id, buf, n);
	cross.sendUs += (performance.now() - t0) * 1000;
	cross.sendCalls++;
	cross.sendOffered += n;
	if (result > 0) cross.sendTaken += result & 0x3fff_ffff;
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
	'netBackpressure',
	'netBorrowed'
] as const;
const diff = (a: ReturnType<typeof stat>, b: ReturnType<typeof stat>) =>
	Object.fromEntries(counters.map((k) => [k, Number(b[k]) - Number(a[k])]));
// PERSIST=1 (SITE=1): one checkpoint of the finished machine written as the keeper writes it, and the interval the
// cadence picks once it has seen that cost
async function persist() {
	if (process.env.PERSIST !== '1' || !store) return undefined;
	// a finished stream stays in the machine's table until the guest takes its end, and a checkpoint refuses it
	await drive(new Promise((r) => setTimeout(r, 300)));
	const cpu = process.cpuUsage();
	const t0 = performance.now();
	try {
		const snapshot = await machine.checkpoint();
		const written = store.writeCheckpoint(snapshot.memory, encodeSnapshot(snapshot));
		const used = process.cpuUsage(cpu);
		const cadence = new Cadence();
		cadence.checkpointed(checkpointCost(snapshot.memory.byteLength, written.changed), written.rows);
		return {
			checkpointWallMs: +(performance.now() - t0).toFixed(1),
			checkpointCpuMs: +((used.user + used.system) / 1000).toFixed(1),
			memoryBytes: snapshot.memory.byteLength,
			changed: written.changed,
			rows: written.rows,
			intervalMs: Math.round(cadence.interval),
			fileSyncs: syncs.calls,
			fileSyncMs: +syncs.ms.toFixed(3)
		};
	} catch (error) {
		return { refused: String((error as Error).message ?? error), fileSyncs: syncs.calls };
	}
}
const memFree = async () => Number(/MemFree:\s+(\d+)/.exec(await sh('grep MemFree /proc/meminfo'))![1]);

// #region setup
await drive(
	(async () => {
		while (!output.includes('# ')) await sleep();
	})()
);
const bootUsed = process.cpuUsage(bootCpu);
const boot = {
	wallMs: +(performance.now() - bootStart).toFixed(1),
	cpuMs: +((bootUsed.user + bootUsed.system) / 1000).toFixed(1)
};
if (bootProf) {
	const { profile } = await bootProf.post('Profiler.stop');
	writeFileSync(process.env.BOOTPROF!, JSON.stringify(profile));
	bootProf.disconnect();
}
if (process.env.BOOT)console.log(output.split('\n').slice(-25).join('\n'));
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
// lighttpd stays in the foreground (a daemonizing fork needs resumable frames); the shell backgrounds it
const started = await sh(
	lighttpd ? 'lighttpd -D -f /etc/lighttpd.conf & echo httpd=$?' : 'httpd -p 80 -h /www; echo httpd=$?'
);
await sh('sleep 1');
const free0 = await memFree();
console.log(
	JSON.stringify({ mode, kernel: dir, server: lighttpd ? 'lighttpd' : 'httpd', listeningBefore, listening: machine.listening(80), free0, started: started.includes('httpd=0') })
);
if (process.env.TAIL) console.log(output.slice(-Number(process.env.TAIL)));
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
} else if (mode === 'http') {
	// each request through the site's own request and response framing, printed as native.sh prints curl's view
	const cases: [string, string, string, Record<string, string>][] = [
		['1k', 'GET', '/1k.txt', {}],
		['404', 'GET', '/nope', {}],
		['head', 'HEAD', '/1k.txt', {}],
		['range', 'GET', '/1k.txt', { range: 'bytes=100-199' }],
		['big', 'GET', '/big.txt', {}],
		['cgi', 'GET', '/cgi-bin/stream.cgi', {}]
	];
	const skip = /^(date|connection|keep-alive|transfer-encoding|last-modified|etag)$/;
	// POOL=<ms> sends them through the site's Server with idle streams kept that long (0 closes each one);
	// PASSES=<n> repeats the six, so the later passes ride the streams the first left open
	const pool = process.env.POOL === undefined ? undefined : Number(process.env.POOL);
	const server =
		pool === undefined
			? undefined
			: new Server(
					{
						open: async () => machine,
						pumping: () => false,
						pump: async (budgetMs, wake) => void (await machine.run(wake, sleep, budgetMs)),
						rest: async () => {},
						wait: (ms) => new Promise<void>((done) => setTimeout(done, ms)),
						fixedLength: () => new TransformStream()
					},
					{ idleMs: pool, port: 80 }
				);
	for (const [name, method, path, headers] of Array.from(
		{ length: Number(process.env.PASSES ?? 1) },
		() => cases
	).flat()) {
		const request = new Request(`http://serve${path}`, { method, headers });
		const opens = machine.stats.netOpens;
		const got = await (server
			? (async () => {
					const response = await server.serve(request);
					const hash = createHash('sha256');
					let bytes = 0;
					if (response.body)
						for await (const part of response.body) {
							hash.update(part);
							bytes += part.length;
						}
					return { response, bytes, sha256: hash.digest('hex') };
				})()
			: drive(
					(async () => {
						const stream = machine.ingress(80);
						for await (const chunk of requestBytes(request)) await stream.write(chunk);
						const response = await responseFrom(stream.readable, method);
						const hash = createHash('sha256');
						let bytes = 0;
						if (response.body)
							for await (const part of response.body) {
								hash.update(part);
								bytes += part.length;
							}
						stream.end();
						return { response, bytes, sha256: hash.digest('hex') };
					})()
				));
		const lines = [...got.response.headers]
			.filter(([n]) => !skip.test(n))
			.map(([n, v]) => `${n}: ${v}`)
			.sort();
		console.log(
			JSON.stringify({
				curl: name,
				status: got.response.status,
				headers: lines.filter((l) => !l.startsWith('content-security-policy')),
				csp: got.response.headers.get('content-security-policy'),
				bytes: got.bytes,
				sha256: got.sha256,
				...(server ? { opens: machine.stats.netOpens - opens, idle: server.idle } : {})
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
	const warmOut = machine.stats.netBytesOut;
	const rounds = Number(process.env.ROUNDS ?? (mode === 'count' ? 1 : 25));
	const shape = process.env.SHAPE;
	const perRound = shape ? Number(process.env.PER_ROUND ?? 100) : 1;
	const workers = Number(process.env.K ?? 1);
	let unitBytes = shape ? -1 : warm.bytes;
	let shortRounds = 0;
	const rows = [];
	const hashes = new Set<string>([warm.sha256]);
	let sys: ReturnType<typeof sysDiff> | undefined;
	const importsBefore = { us: { ...importUs }, calls: { ...importCalls } };
	const statsBefore = { ...machine.stats };
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
		const reply = shape
			? await drive(shapedRound(shape, perRound, workers))
			: await raw(request, undefined, hashRounds);
		const used = process.cpuUsage(cpu);
		if ('served' in reply && reply.served !== perRound) shortRounds++;
		if (unitBytes < 0) unitBytes = reply.bytes;
		if (hashRounds) hashes.add((reply as { sha256: string }).sha256);
		else if (reply.bytes !== unitBytes) hashes.add('bytes differ');
		if (mode === 'count') sys = sysDiff(sysBefore, sysNow());
		// per request: a SHAPE round is perRound of them
		const each = (o: Record<string, number>) =>
			Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v / perRound]));
		rows.push({
			bytes: reply.bytes / perRound,
			wallMs: (performance.now() - t0) / perRound,
			cpuMs: (used.user + used.system) / 1000 / perRound,
			steps: (steps - stepsBefore) / perRound,
			...each(diff(before, stat())),
			...each(crossDiff(crossBefore, crossNow()))
		});
	}
	// after the timed rounds: the guest's steady state, its streams and its tasks
	const steady = shape
		? await (async () => {
				await drive(new Promise((r) => setTimeout(r, 200)));
				return {
					memFreeKb: await memFree(),
					tasks: Number(
						/tasks=(\d+)/.exec(await sh("echo tasks=$(ls /proc | grep -c '^[0-9]')"))?.[1]
					),
					openStreams: machine.openStreams
				};
			})()
		: undefined;
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
			// view and drop replies are not exact: they pass when every round sent as many bytes as the warm-up
			...(sendArm
				? { sendArm, ok: Math.abs(mean('netBytesOut') - warmOut) < 0.5 && machine.crashed == null }
				: {}),
			...(shape
				? { shape, perRound, k: workers, server: lighttpd ? 'lighttpd' : 'httpd', shapeOk: shortRounds === 0, shortRounds, steady }
				: {}),
			crashed: String(machine.crashed),
			cpuMs: { mean: +mean('cpuMs').toFixed(3), minMedianMax: spread('cpuMs') },
			wallMs: { mean: +mean('wallMs').toFixed(3), minMedianMax: spread('wallMs') },
			steps: { mean: +mean('steps').toFixed(1), minMedianMax: spread('steps') },
			perRequest: Object.fromEntries(
				[...counters, ...crossKeys].map((k) => [k, +mean(k).toFixed(shape ? 3 : 1)])
			),
			// bytes per crossing: out per send offered and per send that took bytes, in per event
			bytesPerSend: +(mean('netBytesOut') / mean('sendCalls')).toFixed(1),
			copyUsPer11KiB: +copyUs.toFixed(3),
			...(site
				? {
						site,
						boot,
						kernelUrl: imports.kernelUrl,
						// the machine's counters per request, over the rounds
						statsPerRequest: Object.fromEntries(
							Object.entries(machine.stats)
								.filter(([, v]) => typeof v === 'number')
								.map(([k, v]) => [
									k,
									+(((v as number) - ((statsBefore as any)[k] as number)) / (rounds * perRound)).toFixed(3)
								])
						),
						persist: await persist()
					}
				: {}),
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
	// PROBE=<shell command> runs in the guest at each memory sample and once after the stream ends
	const probes: { ms: number; text: string }[] = [];
	const reply = await raw(REQUESTS.big!, async (chunk) => {
		const wait = (chunk.length / rate) * 1000;
		await new Promise((r) => setTimeout(r, wait));
		// every few seconds of reading, ask the guest how much memory it has free
		if (!probing && Date.now() >= nextAt) {
			probing = true;
			nextAt = Date.now() + 10_000;
			sampled++;
			free.push(await memFree());
				if (process.env.PROBE) probes.push({ ms: Date.now() - slowStart, text: await sh(process.env.PROBE) });
			probing = false;
		}
	}).catch((error) => ({
		error: `${String(error)} after ${Date.now() - slowStart} ms`,
		bytes: 0,
		sha256: ''
	}));
	void lows;
	if (process.env.PROBE)
		probes.push({ ms: Date.now() - slowStart, text: await sh(process.env.PROBE) });
	console.log(
		JSON.stringify({
			mode,
			rate,
			...(process.env.PROBE ? { probes } : {}),
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
		const stream = machine.ingress(80, borrow);
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
		server: lighttpd ? 'lighttpd' : 'httpd',
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
