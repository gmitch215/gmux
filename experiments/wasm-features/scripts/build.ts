import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Assembles wat/*.wat into src/*.bin (Data modules the Worker compiles at startup, one by one, so a
 * feature the runtime lacks fails alone). wabt has no text form for branch hints, so the
 * metadata.code.branch_hint section is written here from wasm-objdump's instruction offsets: in
 * `right` the rare `if` is unlikely and the back edge likely, in `wrong` the reverse.
 * `node --experimental-strip-types scripts/build.ts`
 */
const here = new URL('..', import.meta.url).pathname;
const modules: Record<string, string[]> = {
	tail: ['--enable-tail-call'],
	hint: [],
	mem32: [],
	mem64: ['--enable-memory64'],
	multi: ['--enable-multi-memory'],
	single: [],
	relaxed: ['--enable-relaxed-simd'],
	funcref: ['--enable-function-references']
};

const leb = (v: number) => {
	const out: number[] = [];
	do {
		let b = v & 0x7f;
		v >>>= 7;
		if (v) b |= 0x80;
		out.push(b);
	} while (v);
	return out;
};

/** [function index, body start, [offset of each if / br_if, its opcode name]] from wasm-objdump -d */
function branches(wasm: string) {
	const text = execFileSync('wasm-objdump', ['-d', wasm], { encoding: 'utf8' });
	const funcs = new Map<string, { index: number; at: number; ops: [number, string][] }>();
	let cur: { index: number; at: number; ops: [number, string][] } | null = null;
	for (const line of text.split('\n')) {
		const f = /^([0-9a-f]+) func\[(\d+)\] <(\w+)>:/.exec(line);
		if (f) {
			cur = { index: Number(f[2]), at: parseInt(f[1]!, 16), ops: [] };
			funcs.set(f[3]!, cur);
			continue;
		}
		const i = /^ ([0-9a-f]+): [0-9a-f ]+\|\s*(if|br_if)\b/.exec(line);
		if (i && cur) cur.ops.push([parseInt(i[1]!, 16) - cur.at, i[2]!]);
	}
	return funcs;
}

function hinted(bytes: Uint8Array, entries: { index: number; hints: [number, number][] }[]) {
	const name = new TextEncoder().encode('metadata.code.branch_hint');
	const body = [...leb(entries.length)];
	for (const e of entries) {
		body.push(...leb(e.index), ...leb(e.hints.length));
		for (const [offset, value] of e.hints) body.push(...leb(offset), 1, value);
	}
	const payload = [...leb(name.length), ...name, ...body];
	const section = [0, ...leb(payload.length), ...payload];
	// custom sections may sit anywhere; this one must come before the code section (id 10)
	let at = 8;
	while (at < bytes.length) {
		const id = bytes[at]!;
		let size = 0;
		let shift = 0;
		let p = at + 1;
		for (;;) {
			const b = bytes[p++]!;
			size |= (b & 0x7f) << shift;
			shift += 7;
			if (!(b & 0x80)) break;
		}
		if (id === 10) break;
		at = p + size;
	}
	return new Uint8Array([...bytes.subarray(0, at), ...section, ...bytes.subarray(at)]);
}

for (const [name, flags] of Object.entries(modules)) {
	const out = join(here, 'src', `${name}.bin`);
	execFileSync('wat2wasm', [...flags, '--debug-names', join(here, 'wat', `${name}.wat`), '-o', out]);
	if (name !== 'hint') continue;
	const funcs = branches(out);
	const entries = (['right', 'wrong'] as const).map((f) => {
		const fn = funcs.get(f);
		if (!fn || fn.ops.length !== 2) throw new Error(`${f}: expected an if and a br_if`);
		const likely = (op: string) => (op === 'br_if') === (f === 'right');
		return { index: fn.index, hints: fn.ops.map(([o, op]) => [o, likely(op) ? 1 : 0] as [number, number]) };
	});
	writeFileSync(out, hinted(readFileSync(out), entries));
	console.log(`hint: ${entries.map((e) => `func ${e.index} ${JSON.stringify(e.hints)}`).join(', ')}`);
}
console.log(`built ${Object.keys(modules).join(', ')}`);
