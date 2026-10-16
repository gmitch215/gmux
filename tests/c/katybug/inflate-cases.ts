import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants, crc32, gzipSync } from 'node:zlib';

/**
 * Writes the corpus inflate.sh runs the static GNU gzip over into a directory: gzip files of text, random bytes,
 * zeros and short inputs (stored, fixed, dynamic blocks; around the 32 KiB window), concatenated members, trailing
 * bytes, crafted bad streams, byte flips, every truncation of a small file and sampled ones of a larger one, and
 * cases.txt, one `name|expect|command` per line (expect: taken, refused, any)
 * `node --experimental-strip-types tests/c/katybug/inflate-cases.ts <dir>`
 */
const dir = process.argv[2];
if (!dir) {
	console.error('usage: inflate-cases.ts <dir>');
	process.exit(2);
}
mkdirSync(dir, { recursive: true });

let seed = 20261015;
const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 8;
const text = (n: number) => {
	const words = Array.from({ length: 300 }, () =>
		Array.from({ length: 3 + (rnd() % 8) }, () => String.fromCharCode(97 + (rnd() % 26))).join(
			''
		)
	);
	const b = Buffer.alloc(n);
	let o = 0;
	while (o < n) o += b.write(words[rnd() % words.length] + (rnd() % 7 ? ' ' : '\n'), o);
	return b;
};
const random = (n: number) => Buffer.from(Array.from({ length: n }, () => rnd() & 255));
const kinds: Record<string, (n: number) => Buffer> = {
	text,
	random,
	zeros: (n) => Buffer.alloc(n)
};

const files = new Map<string, Buffer>();
const cases: string[] = [];
const add = (name: string, data: Buffer) => files.set(name, data);
const run = (name: string, expect: string, cmd: string) => cases.push(`${name}|${expect}|${cmd}`);

// #region valid
const sizes = [0, 1, 100, 32767, 32768, 32769, 65536, 100000, 700000];
const options: [string, object][] = [
	['d6', { level: 6 }],
	['d1', { level: 1 }],
	['d9', { level: 9 }],
	['st', { level: 0 }],
	['fx', { strategy: constants.Z_FIXED }]
];
for (const [kind, make] of Object.entries(kinds))
	for (const size of sizes)
		for (const [tag, opts] of options) {
			if (
				(kind !== 'text' && tag !== 'd6' && tag !== 'st') ||
				(size > 100000 && tag !== 'd6')
			)
				continue;
			const name = `ok-${kind}-${size}-${tag}.gz`;
			add(name, gzipSync(make(size), opts));
			run(`dc ${name}`, 'taken', `$G -dc ${name}`);
		}
const small = [...files.keys()].filter(
	(n) => n.includes('text-100000-d6') || n.includes('random-32768-st')
);
for (const name of small) {
	run(`stdin ${name}`, 'taken', `$G -dc < ${name}`);
	run(`split ${name}`, 'taken', `$G -d -c -- ${name}`);
	run(`test ${name}`, 'taken', `$G -t ${name}`);
	run(`list ${name}`, 'any', `$G -l ${name}`);
	run(`pipe-in ${name}`, 'refused', `cat ${name} | $G -dc`);
	run(`pipe-out ${name}`, 'taken', `$G -dc ${name} | cat`);
	run(`head ${name}`, 'any', `$G -dc ${name} | head -c 1000`);
	if (existsSync('/dev/full')) run(`full ${name}`, 'any', `$G -dc ${name} > /dev/full`);
	run(
		`file ${name}`,
		'taken',
		`mkdir $W && cd $W && cp ../${name} w.gz && $G -d w.gz; echo rc $?; ls; cat w`
	);
	run(
		`keep ${name}`,
		'taken',
		`mkdir $W && cd $W && cp ../${name} w.gz && $G -dk w.gz; echo rc $?; ls; cat w`
	);
	run(`two ${name}`, 'taken', `$G -dc ${name} ${name}`);
	run(`closed ${name}`, 'any', `$G -dc ${name} >&-`);
}
run('verbose', 'taken', '$G -dvc ok-text-100000-d6.gz');
// #endregion

// #region members
const a = gzipSync(text(70000));
const b = gzipSync(text(50000));
const c = gzipSync(random(5000), { level: 0 });
add('multi-3.gz', Buffer.concat([a, b, c]));
add('multi-empty.gz', Buffer.concat([a, gzipSync(Buffer.alloc(0)), b]));
add('tail-junk.gz', Buffer.concat([a, Buffer.from('trailing garbage')]));
add('tail-zeros.gz', Buffer.concat([a, Buffer.alloc(40)]));
add('tail-hdr.gz', Buffer.concat([a, Buffer.from([0x1f, 0x8b, 0x08])]));
add(
	'tail-gz-junk.gz',
	Buffer.concat([a, Buffer.from([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 3, 1, 2, 3])])
);
add('member-bad-second.gz', Buffer.concat([a, b.subarray(0, b.length - 20)]));
for (const name of [
	'multi-3.gz',
	'multi-empty.gz',
	'tail-junk.gz',
	'tail-zeros.gz',
	'tail-hdr.gz',
	'tail-gz-junk.gz',
	'member-bad-second.gz'
]) {
	run(`dc ${name}`, 'any', `$G -dc ${name}`);
	run(`test ${name}`, 'any', `$G -t ${name}`);
	run(`stdin ${name}`, 'any', `$G -dc < ${name}`);
}
// #endregion

// #region crafted streams
class Bits {
	bytes: number[] = [];
	n = 0;
	put(v: number, k: number) {
		for (let i = 0; i < k; i++) {
			if (this.n % 8 === 0) this.bytes.push(0);
			this.bytes[this.bytes.length - 1] |= ((v >> i) & 1) << (this.n % 8);
			this.n++;
		}
	}
	// a Huffman code is written most significant bit first
	code(v: number, k: number) {
		for (let i = k - 1; i >= 0; i--) this.put((v >> i) & 1, 1);
	}
	get buffer() {
		return Buffer.from(this.bytes);
	}
}
const header = Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3]);
const wrap = (raw: Buffer, data = Buffer.alloc(0)) => {
	const trailer = Buffer.alloc(8);
	trailer.writeUInt32LE(crc32(data), 0);
	trailer.writeUInt32LE(data.length, 4);
	return Buffer.concat([header, raw, trailer]);
};
const fixedLiteral = (w: Bits, v: number) =>
	v < 144 ? w.code(0x30 + v, 8) : w.code(0x190 + v - 144, 9);
{
	// a match whose distance reaches before the start of the output
	const w = new Bits();
	(w.put(1, 1), w.put(1, 2));
	fixedLiteral(w, 97);
	w.code(1, 7); // length 3
	w.code(4, 5); // distance code 4: 5..6
	w.put(0, 1);
	w.code(0, 7);
	add('bad-far.gz', wrap(w.buffer, Buffer.from('a')));
}
{
	const w = new Bits();
	(w.put(1, 1), w.put(3, 2));
	add('bad-type3.gz', wrap(w.buffer));
}
{
	const w = new Bits();
	(w.put(1, 1), w.put(0, 2), w.put(0, 5), w.put(3, 16), w.put(3, 16));
	add('bad-stored.gz', wrap(Buffer.concat([w.buffer, Buffer.from('abc')])));
}
{
	const w = new Bits();
	(w.put(1, 1), w.put(1, 2));
	fixedLiteral(w, 97);
	w.code(1, 7);
	w.code(30, 5); // distance code 30 does not exist
	w.put(0, 13);
	w.code(0, 7);
	add('bad-dist30.gz', wrap(w.buffer, Buffer.from('a')));
}
{
	const w = new Bits();
	(w.put(1, 1), w.put(2, 2), w.put(0, 5), w.put(0, 5), w.put(0, 4));
	for (let i = 0; i < 4; i++) w.put(1, 3); // four code length codes of length 1: over-subscribed
	add('bad-over.gz', wrap(w.buffer));
}
{
	// the stream's last block is not final: the data ends after a block that promises another
	const w = new Bits();
	(w.put(0, 1), w.put(1, 2));
	fixedLiteral(w, 97);
	w.code(0, 7);
	add('bad-notfinal.gz', wrap(w.buffer, Buffer.from('a')));
}
for (const name of [
	'bad-far.gz',
	'bad-type3.gz',
	'bad-stored.gz',
	'bad-dist30.gz',
	'bad-over.gz'
]) {
	run(`dc ${name}`, 'refused', `$G -dc ${name}`);
	run(`test ${name}`, 'refused', `$G -t ${name}`);
}
run('dc bad-notfinal.gz', 'any', '$G -dc bad-notfinal.gz');
// #endregion

// #region flips and truncations
const base = gzipSync(text(100000));
add('flip-base.gz', base);
const flips: number[] = [
	10,
	11,
	12,
	17,
	18,
	20,
	25,
	100,
	1000,
	5000,
	20000,
	base.length - 9,
	base.length - 8,
	base.length - 5,
	base.length - 4,
	base.length - 1
];
for (let i = 0; i < Number(process.env.FLIPS ?? 160); i++)
	flips.push(10 + (rnd() % (base.length - 10)));
flips.forEach((at, i) => {
	const x = Buffer.from(base);
	x[at] ^= 1 << (rnd() % 8);
	if (i % 5 === 4) x[Math.min(at + 1, x.length - 1)] ^= 0xff;
	add(`flip-${i}.gz`, x);
	run(`flip ${i} at ${at}`, 'any', `$G -dc flip-${i}.gz`);
});
const mixed = gzipSync(
	Buffer.concat([text(40000), random(30000), Buffer.alloc(40000), text(40000)])
);
add('mix-base.gz', mixed);
for (let i = 0; i < Number(process.env.MIXFLIPS ?? 60); i++) {
	const x = Buffer.from(mixed);
	x[10 + (rnd() % (x.length - 10))] ^= 1 << (rnd() % 8);
	add(`mix-flip-${i}.gz`, x);
	run(`mix flip ${i}`, 'any', `$G -dc mix-flip-${i}.gz`);
}
const tiny = gzipSync(Buffer.from('hello hello hello hello hello world'));
for (let n = 0; n <= tiny.length; n++) {
	add(`cut-tiny-${n}.gz`, tiny.subarray(0, n));
	run(`cut tiny ${n}`, 'any', `$G -dc cut-tiny-${n}.gz`);
}
const cuts = new Set<number>();
for (let n = 0; n < 40; n++) (cuts.add(n), cuts.add(base.length - n));
for (let n = 40; n < base.length; n += 211) cuts.add(n);
// the places around the 32 KiB windows: where each window's output ends the input is near these offsets
for (const [i, n] of [...cuts].filter((n) => n > 0 && n < base.length).entries()) {
	add(`cut-${n}.gz`, base.subarray(0, n));
	run(`cut ${n} (${i})`, 'any', `$G -dc cut-${n}.gz`);
}
// every byte of truncation around the first window boundary of a stored stream, and of a fixed stream
for (const [tag, opts] of [
	['st', { level: 0 }],
	['fx', { strategy: constants.Z_FIXED }]
] as [string, object][]) {
	const raw = gzipSync(text(70000), opts);
	for (let n = 10; n < raw.length; n += tag === 'st' ? 4093 : 701) {
		add(`cut-${tag}-${n}.gz`, raw.subarray(0, n));
		run(`cut ${tag} ${n}`, 'any', `$G -dc cut-${tag}-${n}.gz`);
	}
}
// #endregion

// #region not gzip, big
add('plain.txt', text(5000));
run('force-plain', 'refused', '$G -dcf plain.txt');
run('plain', 'refused', '$G -dc plain.txt');
run('missing', 'refused', '$G -dc nothing-here.gz');
add('big-8.gz', gzipSync(text(8 << 20)));
run('big', 'taken', '$G -dc big-8.gz | cksum');
// #endregion

// #region signals while gzip is blocked writing the stream: the reader takes one byte and holds the fifo open
const held = (pre: string) =>
	`mkdir $W && cd $W && mkfifo p && { ${pre}$G -dc ../big-8.gz > p & g=$!; exec 3< p; head -c 1 <&3 > /dev/null; sleep 1; `;
for (const sig of ['TERM', 'HUP', 'USR1', 'KILL'])
	run(`signal ${sig}`, 'any', `${held('')}kill -${sig} $g; wait $g; echo rc $?; }`);
run(
	'signal ignored',
	'any',
	`${held('trap "" TERM; ')}kill -TERM $g; cat <&3 | cksum; wait $g; echo rc $?; }`
);
run(
	'signal stop',
	'any',
	`${held('')}kill -STOP $g; sleep 1; kill -CONT $g; cat <&3 | cksum; wait $g; echo rc $?; }`
);
run(
	'write error',
	'any',
	'(trap "" PIPE; $G -dc big-8.gz; echo rc $? >&2) | head -c 10 > /dev/null'
);
// #endregion

for (const [name, data] of files) writeFileSync(join(dir, name), data);
writeFileSync(join(dir, 'cases.txt'), `${cases.join('\n')}\n`);
console.error(`${files.size} files, ${cases.length} cases in ${dir}`);
