import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { emit, parse, wasmTools } from '../../promotion-ladder/scripts/ladder.ts';

/**
 * The weighted dynamic call graph of a guest: `graph.ts <guest.wasm> <out.json>` (needs wasm-tools).
 *
 * An instrumented copy runs in V8 with a counter per function, bumped at every straight-line segment by
 * its length (the ladder's count), and an entry hook that reads which call site the call came from, so
 * indirect calls get edges too. Counts are per run(1): run(2) less run(1), so the setup cancels. Every
 * static direct call also appears, with count 0 when it never ran, because a native function drags
 * its static callees into the native module whether or not they ran. Code bytes are each function's
 * body size in the binary.
 */
const [guest = '', out = ''] = process.argv.slice(2);
if (!guest || !out) throw new Error('usage: graph.ts <guest.wasm> <out.json>');

/** body sizes of the defined functions, from the code section */
function bodyBytes(bytes: Uint8Array) {
	let p = 8;
	const leb = () => {
		let v = 0;
		let s = 0;
		for (;;) {
			const b = bytes[p++]!;
			v |= (b & 0x7f) << s;
			if (!(b & 0x80)) return v >>> 0;
			s += 7;
		}
	};
	while (p < bytes.length) {
		const id = bytes[p++]!;
		const size = leb();
		if (id === 10) {
			const n = leb();
			return Array.from({ length: n }, () => {
				const body = leb();
				p += body;
				return body;
			});
		}
		p += size;
	}
	throw new Error('no code section');
}

const wasm = readFileSync(guest);
const sizes = bodyBytes(wasm);
const { head, tail, fns } = parse(wasmTools(['print', guest]).toString());
if (sizes.length !== fns.length) throw new Error(`${sizes.length} bodies, ${fns.length} functions`);
const index = new Map(fns.map((fn, i) => [fn.name, i]));

const boundary = /^\s*(block|loop|if|else|end|br_if|br_table|call|call_indirect)\b/;
const callSite = /^\s*call(_indirect)?\b/;
const counted = fns.map((fn, id) => {
	const body: string[] = [`    i32.const ${id}`, '    call $cut_enter'];
	const bump = (k: number) => (k ? [`    global.get $cnt_${fn.name}`, `    i64.const ${k}`, '    i64.add', `    global.set $cnt_${fn.name}`] : []);
	let segment: string[] = [];
	for (const l of fn.body) {
		if (callSite.test(l)) segment.push(`    i32.const ${id}`, '    global.set $cut_caller');
		segment.push(l);
		if (boundary.test(l)) {
			body.push(...bump(segment.length), ...segment);
			segment = [];
		}
	}
	body.push(...bump(segment.length), ...segment);
	return { ...fn, body };
});
const counters = fns.map((fn) => `  (global $cnt_${fn.name} (export "cnt_${fn.name}") (mut i64) i64.const 0)`);
const importAt = head.findLastIndex((l) => /^ {2}\(type/.test(l)) + 1;
const instrumentedHead = [...head];
instrumentedHead.splice(importAt, 0, '  (import "cut" "enter" (func $cut_enter (param i32)))');
const wat = [
	...instrumentedHead,
	...counted.flatMap(emit),
	...counters,
	'  (global $cut_caller (export "cut_caller") (mut i32) i32.const -1)',
	...tail
].join('\n');
// the enter import has type (i32) -> (); wasm-tools needs a matching type entry, which the inline func import declares
const module = new WebAssembly.Module(wasmTools(['parse', '-o', '/dev/stdout'], wat));

const n = fns.length;
let edges = new Float64Array(n * n);
let caller: WebAssembly.Global;
const inst = new WebAssembly.Instance(module, {
	cut: {
		enter: (id: number) => {
			const c = caller.value as number;
			if (c >= 0) edges[c * n + id]!++;
		}
	}
}).exports as Record<string, WebAssembly.Global | ((n: number) => number)>;
caller = inst.cut_caller as WebAssembly.Global;
const call = (units: number) => {
	caller.value = -1;
	return (inst.run as (n: number) => number)(units) >>> 0;
};
const counts = () => fns.map((fn) => Number((inst[`cnt_${fn.name}`] as WebAssembly.Global).value));

call(1);
const oneCounts = counts();
const oneEdges = edges;
edges = new Float64Array(n * n);
for (const fn of fns) (inst[`cnt_${fn.name}`] as WebAssembly.Global).value = 0n;
const checksum = call(2);
const twoCounts = counts();

const edgeList: { from: string; to: string; count: number; indirect?: boolean }[] = [];
const staticEdges = new Set<string>();
fns.forEach((fn, i) => {
	for (const l of fn.body) {
		const m = l.match(/^\s*call \$(\S+)/);
		if (m && index.has(m[1]!)) staticEdges.add(`${i},${index.get(m[1]!)}`);
	}
});
for (let f = 0; f < n; f++)
	for (let t = 0; t < n; t++) {
		const count = edges[f * n + t]! - oneEdges[f * n + t]!;
		if (count || staticEdges.has(`${f},${t}`)) edgeList.push({ from: fns[f]!.name, to: fns[t]!.name, count });
	}
const nodes = fns.map((fn, i) => ({ name: fn.name, count: twoCounts[i]! - oneCounts[i]!, bytes: sizes[i]!, params: fn.params, result: fn.result, wide: fn.wide }));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(
	out,
	JSON.stringify({ guest, checksum, total: nodes.reduce((s, x) => s + x.count, 0), bytes: sizes.reduce((s, x) => s + x, 0), nodes, edges: edgeList }, null, '\t')
);
console.log(`${nodes.length} functions, ${edgeList.length} edges (${edgeList.filter((e) => e.count).length} executed), ${nodes.reduce((s, x) => s + x.count, 0)} instructions a unit, checksum ${checksum.toString(16)}`);
