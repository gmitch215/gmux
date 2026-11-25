import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, rmdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const env = (name: string, fallback?: string) => {
	const v = process.env[name] ?? fallback;
	if (v === undefined) throw new Error(`set ${name}`);
	return v;
};
const coreutils = env('COREUTILS');
const sysSha = env('SYSSHA', 'sha256sum');
const cu911 = env('CU911');
const openssl = env('OPENSSL', 'openssl');
const out = env('OUT');
const cpu = env('CPU');
const lock = env('LOCK');
const quiet = env('QUIET');
const reps = Number(env('REPS', '5'));
const waits = Number(env('WAITS', '8'));
const fileMib = Number(env('FILEMIB', '64'));
const arms = env('ARMS', 'native,sys94,cu911,opensslcli,opensslcli-nosha,nodehash,nodehash1m,nodehash-nosha').split(',');

// bit #64+29 of the extended capability word, the SHA extension (OPENSSL_ia32cap(3))
const noSha = ':~0x20000000';
const dir = resolve(`${out}.files`);
const eight = Array.from({ length: 8 }, (_, i) => join(dir, `d${i}`));
const list = eight.join(' ');
const line = (i: number) => `d8-${i}-the-quick-brown-fox-jumps-over-the-lazy-dog`;

// one read loop per sample, timed inside the process so node's start-up is not in the sample
const nodeScript = `
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const size = Number(process.argv[1]);
const buf = Buffer.allocUnsafe(size);
const digests = [];
const t = process.hrtime.bigint();
for (const f of process.argv.slice(2)) {
	const fd = fs.openSync(f, 'r');
	const h = createHash('sha256');
	let n;
	while ((n = fs.readSync(fd, buf, 0, size, null)) > 0) h.update(buf.subarray(0, n));
	fs.closeSync(fd);
	digests.push(h.digest('hex'));
}
console.log(JSON.stringify({ ms: Number(process.hrtime.bigint() - t) / 1e6, digests }));
`;

type Cell = { cmd?: string; node?: number; env?: Record<string, string> };
const cells: Record<string, Cell> = {
	native: { cmd: `${coreutils} --coreutils-prog=sha256sum ${list}` },
	sys94: { cmd: `${sysSha} ${list}` },
	cu911: { cmd: `${cu911} ${list}` },
	opensslcli: { cmd: `${openssl} dgst -sha256 ${list}` },
	'opensslcli-nosha': { cmd: `${openssl} dgst -sha256 ${list}`, env: { OPENSSL_ia32cap: noSha } },
	nodehash: { node: 32768 },
	nodehash1m: { node: 1048576 },
	'nodehash-nosha': { node: 32768, env: { OPENSSL_ia32cap: noSha } }
};

const digestOf = (text: string) => text.match(/[0-9a-f]{64}(?![0-9a-f])/g)?.join(',') ?? 'none';
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const take = () => {
	for (;;) {
		try {
			mkdirSync(lock);
			return;
		} catch {
			pause(10_000);
		}
	}
};
const q = () => spawnSync('bash', [quiet, cpu, '1'], { encoding: 'utf8' }).stdout.trim().split(' ')[1] ?? '?';

const run = (arm: string) => {
	const c = cells[arm]!;
	const childEnv = { ...process.env, ...c.env };
	if (c.node) {
		const r = spawnSync(process.execPath, ['-e', nodeScript, String(c.node), ...eight], {
			encoding: 'utf8',
			env: childEnv,
			maxBuffer: 1 << 20
		});
		try {
			const j = JSON.parse(r.stdout) as { ms: number; digests: string[] };
			return { ms: j.ms, text: j.digests.join('\n'), status: String(r.status) };
		} catch {
			return { ms: NaN, text: '', status: String(r.status) };
		}
	}
	const t = performance.now();
	const r = spawnSync('sh', ['-c', c.cmd!], { encoding: 'utf8', env: childEnv, maxBuffer: 1 << 20 });
	return { ms: performance.now() - t, text: r.stdout, status: String(r.status) };
};

// a sample takes the timing lock and reads quiet.sh before and after; a busy reading waits, as hash-wasm.ts does
const sample = (arm: string) => {
	for (let t = 0; ; t++) {
		take();
		const q0 = q();
		if (Number(q0) > 0.5 && t < waits) {
			rmdirSync(lock);
			pause(15_000);
			continue;
		}
		try {
			const r = run(arm);
			return { ...r, q0, q1: q() };
		} finally {
			rmdirSync(lock);
		}
	}
};

mkdirSync(dir, { recursive: true });
for (let i = 0; i < 8; i++) {
	const w = spawnSync('sh', ['-c', `yes '${line(i)}' | head -c ${fileMib * 1048576} > ${eight[i]}`]);
	if (w.status !== 0) throw new Error(`could not write ${eight[i]}`);
}

writeFileSync(out, 'arm\ttool\tmib\trep\tms\tquiet_before\tquiet_after\tok\tdigest\tstatus\thost_digests\timport_ms\timport_calls\tupdate_ms\n');
let want = '';
const dead = new Set<string>();
let failedInARow = 0;
for (let rep = 0; rep < reps; rep++)
	for (const arm of arms) {
		if (!cells[arm]) throw new Error(`unknown arm ${arm}`);
		if (dead.has(arm)) continue;
		const s = sample(arm);
		const d = digestOf(s.text);
		if (arm === 'native') want = d;
		const ok = Number(d !== 'none' && d === want && s.status === '0');
		const row = [arm, 'sha256sum', 'd8', rep, s.ms.toFixed(1), s.q0, s.q1, ok, d.slice(0, 8), s.status, 0, 0, 0, 0].join('\t');
		appendFileSync(out, `${row}\n`);
		console.log(row);
		failedInARow = ok ? 0 : failedInARow + 1;
		if (!ok) {
			dead.add(arm);
			console.log(`check failed: ${arm} status ${s.status}, digest ${d}, want ${want}`);
		}
		if (failedInARow >= 3) {
			console.log('three failed checks in a row: stopping');
			process.exit(1);
		}
	}
process.exit(0);
