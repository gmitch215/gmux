import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { appendCpio } from '../../../scripts/wasm/cpio-append.ts';
import { nodeInflater } from '../../../src/worker/machine/inflate.ts';
import { Machine } from '../../../src/worker/machine/machine.ts';

/**
 * Runs the corpus of inflate.sh (CORPUS, which holds gzip, inflate-run.sh and cases.txt next to the files)
 * through a real machine in node: the static GNU gzip under the staged katybug with the guest's own inflate
 * (arm off) and with the host's node:zlib (arm on, the machine's `inflate` option). Each case's out, err and
 * status must be the same in both arms, and where NATIVE holds the native results of the same corpus
 * (inflate.sh's native/ directory) the differences from it are listed; the cases marked taken must take a stream
 * in arm on and the cases marked refused none.
 * env: BUNDLE (a staged build's kernel/: busybox.wasm, vmlinux.wasm, initramfs.bin, manifest.json), WASM and INST
 * (katybug.wasm and its instrumented build), CORPUS, NATIVE, TAKEN, STEP (every STEP-th case, default 1), ONLY (a regex on `name|expect|command`)
 * `node --experimental-strip-types tests/c/katybug/inflate-machine.ts`
 */
const env = (name: string, fallback?: string) => {
	const v = process.env[name] ?? fallback;
	if (v === undefined) throw new Error(`set ${name}`);
	return v;
};
const bundle = resolve(env('BUNDLE'));
const wasm = resolve(env('WASM'));
const inst = resolve(env('INST'));
const corpus = resolve(env('CORPUS'));
const native = process.env.NATIVE ? resolve(process.env.NATIVE) : '';
const step = Number(env('STEP', '1'));
const read = (path: string) => new Uint8Array(readFileSync(path));
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const md5 = (path: string) => createHash('md5').update(readFileSync(path)).digest('hex');

// every step-th case of the list, numbered as in the full run
const lines = readFileSync(join(corpus, 'cases.txt'), 'utf8').split('\n').filter(Boolean);
const only = new RegExp(env('ONLY', ''));
const picked = lines
	.map((line, i) => ({ n: i + 1, line }))
	.filter((c) => (c.n - 1) % step === 0 && only.test(c.line));
const cases = join(mkdtempSync(join(tmpdir(), 'inflate-machine-')), 'cases.txt');
writeFileSync(cases, picked.map((c) => c.line).join('\n') + '\n');
const pairs = readdirSync(corpus)
	.filter((f) => f !== 'cases.txt' && statSync(join(corpus, f)).isFile())
	.map((f) => `/c/${f}=${join(corpus, f)}`);
pairs.push(`/c/cases.txt=${cases}`, `/bin/katybug=${wasm}`);
const base = join(bundle, 'initramfs.bin');
const cpio = `${cases}.cpio`;
appendCpio(base, cpio, pairs);

const manifest = JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8'));
const registry = new Map<string, WebAssembly.Module>([
	[manifest.busybox, new WebAssembly.Module(read(join(bundle, 'busybox.wasm')))]
]);
registry.set(sha256(read(wasm)), new WebAssembly.Module(read(inst)));
let output = '';
const machine = new Machine({
	vmlinux: new WebAssembly.Module(read(join(bundle, 'vmlinux.wasm'))),
	initrd: read(cpio),
	cmdline: 'maxcpus=3 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0',
	registry,
	maximumPages: 4096,
	sha256,
	inflate: nodeInflater,
	sharedKernel: true,
	write: (text) => (output += text)
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.min(ms, 5)));
await machine.run(() => output.includes('# '), sleep, 300_000);
const guest = async (cmd: string) => {
	const mark = `@@${Math.random().toString(36).slice(2)}`;
	const from = output.length;
	machine.type(`${cmd}; echo "${mark.slice(0, 2)}""${mark.slice(2)} $?"\n`);
	await machine.run(
		() =>
			output.indexOf(mark, from) >= 0 && /\n/.test(output.slice(output.indexOf(mark, from))),
		sleep,
		3_600_000
	);
	return output.slice(from, output.indexOf(mark, from));
};

const results = new Map<string, Map<string, string>>();
const streams = new Map<string, number>();
for (const arm of ['off', 'on']) {
	const before = machine.stats.inflates;
	await guest(`cd /c && B=/bin/busybox && $B mkdir -p /o && sh inflate-run.sh ${arm} /o/${arm}`);
	console.log(`arm ${arm}: ${machine.stats.inflates - before} streams on the host`);
	const text = await guest(
		`cd /o/${arm} && for f in *.out *.err *.rc; do $B md5sum $f; done; for f in *.log; do echo "log $f $($B cat $f | $B tr '\\n' ' ')"; done`
	);
	const map = new Map<string, string>();
	for (const l of text.split('\n')) {
		const m = /^([0-9a-f]{32}) {2}(\S+)$/.exec(l.trim());
		if (m) map.set(m[2]!, m[1]!);
		const t = /^log (\d+)\.log (.*)$/.exec(l.trim());
		if (t && arm === 'on')
			streams.set(
				t[1]!,
				[...t[2]!.matchAll(/inflate (\d+)/g)].reduce((n, x) => n + Number(x[1]), 0)
			);
	}
	results.set(arm, map);
}

// TAKEN: inflate.sh's taken.txt, the streams the native test double took per case
const counts = process.env.TAKEN
	? readFileSync(resolve(process.env.TAKEN), 'utf8').split('\n').filter(Boolean).map(Number)
	: [];
let fail = 0;
let differ = 0;
let tookAny = 0;
for (let k = 0; k < picked.length; k++) {
	const { n, line } = picked[k]!;
	const i = k + 1; // the guest numbered its slice from 1
	const [name, expect] = line.split('|');
	for (const ext of ['out', 'err', 'rc']) {
		const a = results.get('off')!.get(`${i}.${ext}`);
		const b = results.get('on')!.get(`${i}.${ext}`);
		if (a === undefined || a !== b) {
			console.log(`FAIL ${name} (${n}): on differs from off in ${ext} (${a} ${b})`);
			fail++;
		}
		if (native && a !== undefined && a !== md5(join(native, `${n}.${ext}`))) {
			console.log(`differs from native: ${name} (${n}) ${ext}`);
			differ++;
		}
	}
	const taken = streams.get(String(i)) ?? 0;
	if (taken) tookAny++;
	if (counts[n - 1] !== undefined && counts[n - 1] !== taken)
		console.log(
			`streams differ from the test double: ${name} (${n}) ${counts[n - 1]} ${taken}`
		);
	if (expect === 'taken' && !taken) {
		console.log(`FAIL ${name} (${n}): no stream taken`);
		fail++;
	}
	if (expect === 'refused' && taken) {
		console.log(`FAIL ${name} (${n}): ${taken} streams taken of a refused stream`);
		fail++;
	}
}
console.log(
	`${picked.length} cases in the machine, host streams taken in ${tookAny}, ${differ} output files differ from native (the machine's own tools), ${fail} FAIL`
);
process.exit(fail ? 1 : 0);
