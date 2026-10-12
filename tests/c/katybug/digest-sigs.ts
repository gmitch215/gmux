import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Prints src/gmux/katybug/digest-sigs.h: for each hash of the static x86-64 coreutils 9.5 that
 * userland-build.sh makes, the stream function's whole code (a hash and where its process_block call
 * returns) and the finish function's regions (a stub, the function it calls and the one it jumps to,
 * or the whole function), as FNV-1a hashes of their bytes. A region ends where the compiler's padding
 * starts.
 * `node --experimental-strip-types tests/c/katybug/digest-sigs.ts <coreutils> [llvm bin dir]`
 */
const [path, llvm = process.env.LLVM ?? '/opt/homebrew/opt/llvm/bin'] = process.argv.slice(2);
if (!path) {
	console.error('usage: digest-sigs.ts <coreutils> [llvm bin dir]');
	process.exit(2);
}
const file = readFileSync(path);
const TEXT = 0x400000;

interface Algorithm {
	name: string;
	/** where the context sits in the stream function's frame, from its stack pointer at the call */
	ctx: number;
	/** the stream function's entry, and the process_block entry its call reaches */
	body: number;
	block: number;
	/** the stub or function the stream function calls to finish, and what it calls and jumps to */
	finish: number;
	conclude?: number;
	read?: number;
}

// found from the callers of each process_block (the K34 rows' functions) in this one build
const algorithms: Algorithm[] = [
	{ name: 'md5', ctx: 0, body: 0x49ac30, block: 0x49ae70, finish: 0x49b5d0 },
	{ name: 'sha1', ctx: 0, body: 0x49bc30, block: 0x49bea0, finish: 0x49d2b0 },
	{
		name: 'sha256',
		ctx: 0x10,
		body: 0x49d850,
		block: 0x49db20,
		finish: 0x4a0840,
		conclude: 0x4a06c0,
		read: 0x49da20
	},
	{
		name: 'sha512',
		ctx: 0x10,
		body: 0x4a0d70,
		block: 0x4a1060,
		finish: 0x4a50d0,
		conclude: 0x4a4f70,
		read: 0x4a0f60
	}
];

const listing = execFileSync(join(llvm, 'llvm-objdump'), ['-d', '--no-show-raw-insn', path], {
	maxBuffer: 1 << 28
})
	.toString()
	.split('\n');
const ins: { at: number; text: string }[] = [];
for (const line of listing) {
	const m = /^\s+([0-9a-f]+):\s+(.*)$/.exec(line);
	if (m) ins.push({ at: parseInt(m[1], 16), text: m[2].trim() });
}
const index = new Map(ins.map((x, i) => [x.at, i]));

/** the function at start ends at the last instruction before padding that nothing jumps over */
function extent(start: number): number {
	let i = index.get(start)!;
	let reach = start;
	for (; ; i++) {
		const { at, text } = ins[i];
		const target = /^j\w+\s+0x([0-9a-f]+)/.exec(text);
		if (target) {
			const t = parseInt(target[1], 16);
			if (t > at && t < at + 0x2000) reach = Math.max(reach, t);
		}
		const next = ins[i + 1];
		const ends = /^(retq|jmp|callq\s+0x4ea84e)/.test(text);
		if (ends && at >= reach && next && /^nop/.test(next.text)) return next.at;
		if (ends && at >= reach && next && next.at % 16 === 0) return next.at;
	}
}

const fnv = (b: Buffer): bigint => {
	let h = 0xcbf29ce484222325n;
	for (const x of b) h = ((h ^ BigInt(x)) * 0x100000001b3n) & 0xffffffffffffffffn;
	return h;
};
const bytes = (start: number, end: number) => file.subarray(start - TEXT, end - TEXT);
const hex = (v: bigint) => `0x${v.toString(16).padStart(16, '0')}ull`;

const rows: string[] = [];
for (const a of algorithms) {
	const bodyEnd = extent(a.body);
	// the call to process_block, the instruction after it is where it returns
	const call = ins.find(
		(x) =>
			x.at >= a.body &&
			x.at < bodyEnd &&
			x.text.startsWith('callq') &&
			parseInt(x.text.split('0x')[1], 16) === a.block
	)!;
	const ret = ins[index.get(call.at)! + 1].at;
	const body = bytes(a.body, bodyEnd);
	// a stream function that calls its finish directly (the generic one gets it in r13: 0)
	const direct = ins.find(
		(x) =>
			x.at >= a.body &&
			x.at < bodyEnd &&
			x.text.startsWith('callq') &&
			parseInt(x.text.split('0x')[1], 16) === a.finish
	);
	const fin = direct ? ins[index.get(direct.at)! + 1].at - a.body : 0;
	console.error(
		`${a.name} body ${a.body.toString(16)}-${bodyEnd.toString(16)} ret ${ret.toString(16)}`
	);
	const regions: [number, number][] = [];
	if (a.conclude) {
		const stubEnd = extent(a.finish);
		regions.push([a.finish, stubEnd]);
		regions.push([a.conclude, extent(a.conclude)]);
		regions.push([a.read!, extent(a.read!)]);
	} else regions.push([a.finish, extent(a.finish)]);
	for (const [s, e] of regions) {
		const last = ins[index.get(e)! - 1];
		console.error(
			`  region ${s.toString(16)}-${e.toString(16)} (${e - s} bytes) last ${last.text}`
		);
	}
	const whole = Buffer.concat(regions.map(([s, e]) => bytes(s, e)));
	const first = bytes(regions[0][0], regions[0][0] + 8);
	const r = regions
		.map(([s, e]) => `{${s - a.finish}, ${e - s}}`)
		.concat(Array(3 - regions.length).fill('{0, 0}'))
		.join(', ');
	rows.push(
		`{${body.length}, ${hex(body.readBigUInt64LE(0))}, ${hex(fnv(body))}, ${ret - a.body}, ${a.ctx}, ${fin}, ${hex(first.readBigUInt64LE(0))}, ${hex(fnv(whole))}, ${regions.length}, {${r}}}, /* ${a.name} */`
	);
}
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '../../../src/gmux/katybug/digest-sigs.h');
writeFileSync(
	out,
	`/* generated by tests/c/katybug/digest-sigs.ts: the static x86-64 coreutils 9.5 (Alpine 3.20, gcc -O2) */\n${rows.join('\n')}\n`
);
execFileSync('bash', [join(here, '../../../format.sh'), out], { stdio: 'inherit' });
console.error(`wrote ${out}`);
