import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Fuel over a --generate-names wat: count down at every loop head, and yield to the host at zero.
 * `fuel-pass.ts in.wat out.wat`
 */
const [src, dst] = process.argv.slice(2);
let text = readFileSync(src!, 'utf8');
// the import goes first, so it takes no index; everything is referenced by name
const firstImport = text.indexOf('  (import ');
if (firstImport < 0) throw new Error(`${src}: no imports`);
text =
	text.slice(0, firstImport) +
	'  (import "env" "__gmux_fuel" (func $gmux.fuel (result i32)))\n' +
	text.slice(firstImport);
// one mutable global, before the first func
const func = text.search(/\n {2}\(func /);
text =
	text.slice(0, func) +
	`\n  (global $gmux.budget (mut i32) (i32.const ${process.env.GMUX_FUEL_PEEK ? 0 : 100000}))` +
	text.slice(func);
// GMUX_FUEL_PEEK=1 (a measurement) reads the budget global without counting, and never yields
const peek = !!process.env.GMUX_FUEL_PEEK;
// GMUX_FUEL_NOCALL=1 (a measurement) counts as usual and refills at zero without calling the host, to
// price the call in the loop apart from the count
const refill = process.env.GMUX_FUEL_NOCALL ? 'i32.const 100000' : 'call $gmux.fuel';
const counting = [
	'global.get $gmux.budget',
	'i32.const 1',
	'i32.sub',
	'global.set $gmux.budget',
	'global.get $gmux.budget',
	'i32.const 0',
	'i32.lt_s'
];
const lines = (ind: string, ops: string[]) => ops.map((l) => ind + l).join('\n');
const check = (ind: string) =>
	lines(ind, [
		...(peek ? ['global.get $gmux.budget'] : counting),
		'if',
		`  ${refill}`,
		'  global.set $gmux.budget',
		'end'
	]);
// GMUX_FUEL_LOCAL=1: a loop that makes no call keeps its count in a local, loaded from the global
// before the loop and written back at every way out of it; the check at a nested loop's head counts
// the same local. A loop it cannot prove call-free keeps the global count
let local = process.env.GMUX_FUEL_LOCAL === '1' && !peek;
// GMUX_FUEL_LOCAL=0 forces it off, 1 on. Unset: on when at least this share of a program's outermost
// loops make no call (gzip 0.64 and bzip2 0.77 on; lua 0.55 and sqlite 0.54 off; sed 0.47, gawk 0.44)
const LOCAL_SHARE = 0.6;
const localCheck = (ind: string) =>
	lines(ind, [
		'local.get $gmux.b',
		'i32.const 1',
		'i32.sub',
		'local.tee $gmux.b',
		'i32.const 0',
		'i32.lt_s',
		'if',
		'  local.get $gmux.b',
		'  global.set $gmux.budget',
		`  ${refill}`,
		'  local.tee $gmux.b',
		'  global.set $gmux.budget',
		'end'
	]);
// GMUX_FUEL_FORM=callout: a loop with no params or results leaves through a branch at underflow, the
// host call sits outside it, and the wrapper enters it again at its head. The refill is one more
// than the host's answer, so the head's own count-down leaves the budget where today's check does
const callout = process.env.GMUX_FUEL_FORM === 'callout' && !peek;
if (process.env.GMUX_FUEL_FORM && process.env.GMUX_FUEL_FORM !== 'callout')
	throw new Error(`GMUX_FUEL_FORM=${process.env.GMUX_FUEL_FORM}: only callout exists`);
const calloutCheck = (ind: string, id: number, counted: boolean) =>
	lines(
		ind,
		counted
			? [
					'local.get $gmux.b',
					'i32.const 1',
					'i32.sub',
					'local.tee $gmux.b',
					'i32.const 0',
					'i32.lt_s',
					`br_if $gmux.yield.${id}`
				]
			: [...counting, `br_if $gmux.yield.${id}`]
	);
// GMUX_FUEL_LSHAPE=1 (a measurement): the hoisted loops keep the preheader, the local and the exit
// code but count in the global, so only the code shape differs from the local count
const lshape = !!process.env.GMUX_FUEL_LSHAPE;
const writeBack = lshape
	? ['local.get $gmux.b', 'drop']
	: ['local.get $gmux.b', 'global.set $gmux.budget'];
// GMUX_FUEL_LOCAL_ONLY=3,10-20,$name (a measurement): hoist only these outermost call-free loops,
// numbered in module order, or those in these functions
const only = (process.env.GMUX_FUEL_LOCAL_ONLY ?? '').split(',').filter(Boolean);
const picked = (n: number, fn: string) =>
	!only.length ||
	only.some((p) => {
		if (p.startsWith('$')) return p === fn;
		const [a, b = a] = p.split('-').map(Number);
		return n >= a! && n <= b!;
	});
// GMUX_FUEL_LOCAL_MAXFN=n (a measurement): no local count in a function longer than n instructions
const maxFn = Number(process.env.GMUX_FUEL_LOCAL_MAXFN ?? Infinity);
let candidates = 0;
const listing: string[] = [];
const OPENS = new Set(['block', 'loop', 'if', 'try', 'try_table']);
// anything that can reach the host, throw or park the thread
const BLOCKING = new Set([
	'call',
	'call_indirect',
	'call_ref',
	'return_call',
	'return_call_indirect',
	'return_call_ref',
	'memory.grow',
	'throw',
	'throw_ref',
	'rethrow',
	'try',
	'try_table',
	'delegate',
	'catch',
	'catch_all'
]);
const blocking = (op: string) =>
	BLOCKING.has(op) || op.startsWith('memory.atomic.wait') || op.startsWith('br_on');
// a numeric label would shift under the wrapper's three blocks; --generate-names names every one
const LABELS = new Set(['br', 'br_if', 'br_table']);
// wrap: the call-out wrapper's id, region: how the loop's count is kept (see hoist)
type Frame = {
	name: string | null;
	typed: boolean;
	wrap: number;
	region: 'none' | 'outer' | 'inner';
};
let hoisted = 0;
let loops = 0;
let wrapped = 0;

/** a function body's instructions and which of its loops are call-free (by instruction index) */
function analyze(body: string[]) {
	const closing =
		body[body.length - 1]!.endsWith(')') && !body[body.length - 1]!.startsWith('    (');
	const ops = body.map((line, n) => {
		const s = (n === body.length - 1 && closing ? line.slice(0, -1) : line).trim();
		const [op = '', ...rest] = s.split(/\s+/);
		return { op, rest, ind: line.slice(0, line.length - line.trimStart().length) };
	});
	const free = new Map<number, boolean>();
	const open: number[] = [];
	ops.forEach((o, n) => {
		if (OPENS.has(o.op)) {
			open.push(n);
			if (o.op === 'loop') free.set(n, true);
		} else if (o.op === 'end' || o.op === 'delegate') open.pop();
		else if (blocking(o.op))
			for (let k = open.length - 1; k >= 0; k--) {
				if (ops[open[k]!]!.op !== 'loop') continue;
				// a loop already marked has every loop outside it marked too
				if (!free.get(open[k]!)) break;
				free.set(open[k]!, false);
			}
	});
	return { closing, ops, free };
}

/** the outermost loops of a function, and how many of them are call-free */
function loopShape(body: string[]) {
	const { ops, free } = analyze(body);
	const open: number[] = [];
	let depth = 0;
	let all = 0;
	let calls = 0;
	ops.forEach((o, n) => {
		if (OPENS.has(o.op)) {
			open.push(n);
			if (o.op === 'loop') depth++;
		} else if (o.op === 'end' || o.op === 'delegate') {
			const start = open.pop()!;
			if (ops[start]!.op === 'loop' && --depth === 0) {
				all++;
				if (free.get(start)) calls++;
			}
		}
	});
	return { all, free: calls };
}

/** one function's body lines (without the header), with the outermost call-free loops hoisted */
function hoist(body: string[], fn: string): string[] | null {
	const { closing, ops, free } = analyze(body);
	if (!free.size || (!callout && ![...free.values()].some(Boolean))) return null;
	const add = (ind: string, list: string[]) => list.forEach((l) => res.push(ind + l));
	const res: string[] = [];
	const stack: Frame[] = [];
	let at = -1;
	// the depth of an outermost call-free loop left on the global count
	let off = -1;
	// the depth of a label operand in the stack; -1 is the function's own label
	const depth = (label: string) =>
		label.startsWith('$')
			? stack.findLastIndex((f) => f.name === label)
			: Math.max(stack.length - 1 - Number(label), -1);
	ops.forEach((o, n) => {
		const line = body[n]!.slice(0, closing && n === body.length - 1 ? -1 : undefined);
		const exits = (label: string) => at >= 0 && depth(label) < at;
		if (
			callout &&
			LABELS.has(o.op) &&
			o.rest.some((l) => /^\d/.test(l)) &&
			stack.some((f) => f.wrap)
		)
			throw new Error(`${fn}: numeric label in a wrapped loop: ${line.trim()}`);
		if (OPENS.has(o.op)) {
			const candidate =
				local && o.op === 'loop' && at < 0 && off < 0 && free.get(n) && ops.length <= maxFn;
			const hoists = candidate && picked(candidates, fn);
			if (candidate) {
				listing.push(`${candidates} ${fn} ${ops.length}`);
				candidates++;
				if (!hoists) off = stack.length;
			}
			const typed = line.includes('(result') || line.includes('(param');
			const wrap = callout && o.op === 'loop' && !typed ? ++wrapped : 0;
			const preheader = ['global.get $gmux.budget', 'local.set $gmux.b'];
			if (hoists) at = stack.length;
			if (wrap)
				add(o.ind, [
					`block $gmux.done.${wrap}`,
					`loop $gmux.re.${wrap}`,
					...(hoists ? preheader : []),
					`block $gmux.yield.${wrap}`
				]);
			else if (hoists) add(o.ind, preheader);
			res.push(line);
			// the count lives in the local at a loop inside a hoisted one, and the outermost one reloads it
			// at the wrapper's head
			const region = at < 0 || lshape ? 'none' : hoists ? 'outer' : 'inner';
			stack.push({
				name: o.rest[0]?.startsWith('$') ? o.rest[0] : null,
				typed,
				wrap,
				region
			});
			if (o.op === 'loop') {
				loops++;
				res.push(
					wrap
						? calloutCheck(o.ind + '  ', wrap, region !== 'none')
						: (region !== 'none' ? localCheck : check)(o.ind + '  ')
				);
				if (at >= 0) hoisted++;
			}
			return;
		}
		// a numeric label that leaves wrapped loops moves out by the wrapper's three blocks
		const moved = (t: number, label: string) =>
			Number(label) + 3 * stack.filter((f, p) => f.wrap && p > t).length;
		if (o.op === 'end' || o.op === 'delegate') {
			// delegate's label counts from outside the try it closes
			res.push(
				o.op === 'delegate' && callout
					? `${o.ind}delegate ${moved(stack.length - 2 - Number(o.rest[0]), o.rest[0]!)}`
					: line
			);
			const top = stack.pop()!;
			if (off === stack.length) off = -1;
			if (at === stack.length) {
				add(o.ind, writeBack);
				at = -1;
			}
			if (top.wrap) {
				const id = top.wrap;
				add(o.ind, [
					`br $gmux.done.${id}`,
					'end',
					...(top.region === 'none' ? [] : writeBack),
					refill,
					'i32.const 1',
					'i32.add',
					...(top.region === 'inner' ? ['local.tee $gmux.b'] : []),
					'global.set $gmux.budget',
					`br $gmux.re.${id}`,
					'end',
					'end'
				]);
			}
		} else if (o.op === 'return' && at >= 0) {
			add(o.ind, writeBack);
			res.push(line);
		} else if (o.op === 'br' && exits(o.rest[0]!)) {
			add(o.ind, writeBack);
			res.push(line);
		} else if (o.op === 'br_table' && o.rest.some(exits)) {
			add(o.ind, writeBack);
			res.push(line);
		} else if (o.op === 'br_if' && exits(o.rest[0]!)) {
			const k = depth(o.rest[0]!);
			if (k >= 0 && !stack[k]!.typed) {
				// the write-back only when the branch is taken, so the loop pays nothing for it
				const label = o.rest[0]!.startsWith('$')
					? o.rest[0]!
					: String(Number(o.rest[0]) + 1);
				add(o.ind, ['if', ...writeBack.map((l) => '  ' + l), `  br ${label}`, 'end']);
			} else {
				add(o.ind, writeBack);
				res.push(line);
			}
		} else if (o.op === 'rethrow' && callout && /^\d/.test(o.rest[0] ?? ''))
			res.push(`${o.ind}rethrow ${moved(stack.length - 1 - Number(o.rest[0]), o.rest[0]!)}`);
		else res.push(line);
	});
	if (closing) res[res.length - 1] += ')';
	return res;
}

const out: string[] = [];
const input = text.split('\n');
// GMUX_FUEL_LOCAL unset: decided per program from its loop shape (see LOCAL_SHARE)
if (process.env.GMUX_FUEL_LOCAL === undefined || process.env.GMUX_FUEL_STATS) {
	let all = 0;
	let calls = 0;
	for (let i = 0; i < input.length; i++) {
		if (!input[i]!.startsWith('  (func ')) continue;
		let j = i + 1;
		while (j < input.length && input[j]!.startsWith('    ')) j++;
		if (j === i + 1) continue;
		const m = loopShape(input.slice(i + 1, j));
		all += m.all;
		calls += m.free;
	}
	if (process.env.GMUX_FUEL_STATS)
		console.error(
			`outermost loops ${all} call-free ${calls} share ${(calls / all).toFixed(3)}`
		);
	if (process.env.GMUX_FUEL_LOCAL === undefined)
		local = all > 0 && calls / all >= LOCAL_SHARE && !peek;
}
for (let i = 0; i < input.length; i++) {
	const line = input[i]!;
	if ((local || callout) && line.startsWith('  (func ')) {
		let j = i + 1;
		while (j < input.length && input[j]!.startsWith('    ')) j++;
		const body = input.slice(i + 1, j);
		const changed = body.length
			? hoist(body, line.match(/^ {2}\(func (\$\S+)/)?.[1] ?? '')
			: null;
		if (changed) {
			out.push(line);
			if (changed.some((l) => /\$gmux\.b\b/.test(l))) out.push('    (local $gmux.b i32)');
			out.push(...changed);
			i = j - 1;
			continue;
		}
	}
	out.push(line);
	const s = line.trimStart();
	if (s.startsWith('loop') && (s.length === 4 || ' ;'.includes(s[4]!))) {
		out.push(check(line.slice(0, line.length - s.length) + '  '));
		loops++;
	}
}
writeFileSync(dst!, out.join('\n'));
if (process.env.GMUX_FUEL_LIST)
	writeFileSync(process.env.GMUX_FUEL_LIST, listing.join('\n') + '\n');
console.log(
	`instrumented ${loops} loops${local ? `, ${hoisted} with a local count` : ''}${callout ? `, ${wrapped} in the call-out form` : ''}`
);
