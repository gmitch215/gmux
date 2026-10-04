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
const check = (ind: string) =>
	[
		...(peek ? ['global.get $gmux.budget'] : counting),
		'if',
		`  ${refill}`,
		'  global.set $gmux.budget',
		'end'
	]
		.map((l) => ind + l)
		.join('\n');
// GMUX_FUEL_LOCAL=1 (a measurement): a loop that makes no call keeps its count in a local, loaded
// from the global before the loop and written back at every way out of it; the check at a nested
// loop's head counts the same local. A loop it cannot prove call-free keeps the global count
const local = !!process.env.GMUX_FUEL_LOCAL && !peek;
const localCheck = (ind: string) =>
	[
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
	]
		.map((l) => ind + l)
		.join('\n');
const writeBack = ['local.get $gmux.b', 'global.set $gmux.budget'];
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
type Frame = { name: string | null; typed: boolean };
let hoisted = 0;

/** one function's body lines (without the header), with the outermost call-free loops hoisted */
function hoist(body: string[]): string[] | null {
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
		} else if (o.op === 'end') open.pop();
		else if (blocking(o.op))
			for (let k = open.length - 1; k >= 0; k--) {
				if (ops[open[k]!]!.op !== 'loop') continue;
				// a loop already marked has every loop outside it marked too
				if (!free.get(open[k]!)) break;
				free.set(open[k]!, false);
			}
	});
	if (![...free.values()].some(Boolean)) return null;
	const res: string[] = [];
	const stack: Frame[] = [];
	let at = -1;
	// the depth of a label operand in the stack; -1 is the function's own label
	const depth = (label: string) =>
		label.startsWith('$')
			? stack.findLastIndex((f) => f.name === label)
			: Math.max(stack.length - 1 - Number(label), -1);
	const add = (ind: string, lines: string[]) => lines.forEach((l) => res.push(ind + l));
	ops.forEach((o, n) => {
		const line = body[n]!.slice(0, closing && n === body.length - 1 ? -1 : undefined);
		const exits = (label: string) => at >= 0 && depth(label) < at;
		if (OPENS.has(o.op)) {
			const hoists = o.op === 'loop' && at < 0 && free.get(n);
			if (hoists) {
				at = stack.length;
				add(o.ind, ['global.get $gmux.budget', 'local.set $gmux.b']);
			}
			res.push(line);
			stack.push({
				name: o.rest[0]?.startsWith('$') ? o.rest[0] : null,
				typed: line.includes('(result') || line.includes('(param')
			});
			if (o.op === 'loop') {
				res.push((at >= 0 ? localCheck : check)(o.ind + '  '));
				if (at >= 0) hoisted++;
			}
			return;
		}
		if (o.op === 'end') {
			res.push(line);
			stack.pop();
			if (at === stack.length) {
				add(o.ind, writeBack);
				at = -1;
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
		} else res.push(line);
	});
	if (closing) res[res.length - 1] += ')';
	return res;
}

const out: string[] = [];
let loops = 0;
const lines = text.split('\n');
for (let i = 0; i < lines.length; i++) {
	const line = lines[i]!;
	if (local && line.startsWith('  (func ')) {
		let j = i + 1;
		while (j < lines.length && lines[j]!.startsWith('    ')) j++;
		const body = lines.slice(i + 1, j);
		const changed = body.length ? hoist(body) : null;
		if (changed) {
			out.push(line, '    (local $gmux.b i32)', ...changed);
			loops += changed.filter((l) => /^\s*loop( |$)/.test(l)).length;
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
console.log(`instrumented ${loops} loops${local ? `, ${hoisted} with a local count` : ''}`);
