import { execFileSync } from 'node:child_process';

/**
 * The metadata.code.branch_hint section: a writer for a module that already exists, and the reader of `if` and `br_if` offsets
 * that wabt's text form cannot express. Offsets are relative to the start of a function's body, as wasm-objdump prints them.
 */
export const leb = (v: number) => {
	const out: number[] = [];
	do {
		let b = v & 0x7f;
		v >>>= 7;
		if (v) b |= 0x80;
		out.push(b);
	} while (v);
	return out;
};

export interface Entry {
	index: number;
	// [offset of an if or br_if, 1 when taken is likely and 0 when it is not]
	hints: [number, number][];
}

/** [function index, body start, [offset of each if / br_if, its opcode name]] from wasm-objdump -d */
export function branches(wasm: string) {
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

const u32 = (b: Uint8Array, p: number): [number, number] => {
	let v = 0;
	let shift = 0;
	for (;;) {
		const x = b[p++]!;
		v += (x & 0x7f) * 2 ** shift;
		shift += 7;
		if (!(x & 0x80)) return [v, p];
	}
};

const SECTION = 'metadata.code.branch_hint';

/**
 * The module with the section written before its code section. `firstDefined` is the index of the first function the code section
 * defines (the count of imported functions). A hint whose offset is not an `if` or `br_if` opcode, a value other than 0 or 1, a
 * repeated offset or function, or a module that has the section already, throws.
 */
export function hinted(bytes: Uint8Array, entries: Entry[], firstDefined: number): Uint8Array {
	const name = new TextEncoder().encode(SECTION);
	let at = 8;
	let code = -1;
	while (at < bytes.length) {
		const id = bytes[at]!;
		const [size, p] = u32(bytes, at + 1);
		if (id === 0) {
			const [n, q] = u32(bytes, p);
			if (new TextDecoder().decode(bytes.subarray(q, q + n)) === SECTION) throw new Error(`the module has a ${SECTION} section already`);
		}
		if (id === 10) {
			code = p;
			break;
		}
		at = p + size;
	}
	if (code < 0) throw new Error('no code section');
	const [count, first] = u32(bytes, code);
	let p = first;
	const bodies: number[] = [];
	for (let k = 0; k < count; k++) {
		const [size, q] = u32(bytes, p);
		bodies.push(q);
		p = q + size;
	}
	const sorted = entries
		.filter((e) => e.hints.length)
		.map((e) => ({ index: e.index, hints: [...e.hints].sort((a, b) => a[0] - b[0]) }))
		.sort((a, b) => a.index - b.index);
	const body = [...leb(sorted.length)];
	let prev = -1;
	for (const e of sorted) {
		if (e.index === prev) throw new Error(`function ${e.index} appears twice`);
		prev = e.index;
		const start = bodies[e.index - firstDefined];
		if (start === undefined) throw new Error(`function ${e.index} is not in the code section`);
		body.push(...leb(e.index), ...leb(e.hints.length));
		let last = -1;
		for (const [offset, value] of e.hints) {
			if (value !== 0 && value !== 1) throw new Error(`function ${e.index}: hint value ${value}`);
			if (offset === last) throw new Error(`function ${e.index}: offset ${offset} hinted twice`);
			last = offset;
			const opcode = bytes[start + offset];
			if (opcode !== 0x04 && opcode !== 0x0d) throw new Error(`function ${e.index}: offset ${offset} is not an if or br_if (opcode ${opcode})`);
			body.push(...leb(offset), 1, value);
		}
	}
	const payload = [...leb(name.length), ...name, ...body];
	const section = [0, ...leb(payload.length), ...payload];
	const out = new Uint8Array(bytes.length + section.length);
	out.set(bytes.subarray(0, at));
	out.set(section, at);
	out.set(bytes.subarray(at), at + section.length);
	return out;
}
