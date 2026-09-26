import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Split stacks for a --generate-names wat: each new stack pointer a frame allocation computes (an
 * i32.sub whose result reaches global.set $__stack_pointer) is checked against the segment limits the
 * host sets through __gmux_set_stack_limits(high, low). Outside them, env.__gmux_stack_move gets it
 * and returns the stack pointer to use: the same one after a return into an older segment, or one at
 * the top of a new segment when the frame does not fit, which is how a stack grows without an MMU.
 * Frames never move: each function's epilogue rebuilds its caller's stack pointer from its own frame.
 * Writes that restore a saved value are not checked. musl's __wasm_crtjmp, which moves to another
 * stack on purpose, is left alone. The limits start wide open, so code that runs before the host sets
 * them is not stopped. The host puts the lower limit a guard of GUARD bytes above the segment's real
 * bottom, so a function that calls nothing and allocates at most GUARD needs no check: its caller's
 * check left room. `stack-pass.ts in.wat out.wat`
 */
const [src, dst] = process.argv.slice(2);
let text = readFileSync(src!, 'utf8');
const firstImport = text.indexOf('  (import ');
if (firstImport < 0) throw new Error(`${src}: no imports`);
text =
	text.slice(0, firstImport) +
	'  (import "env" "__gmux_stack_move" (func $gmux.stack_move (param i32) (result i32)))\n' +
	text.slice(firstImport);
const func = text.search(/\n {2}\(func /);
text =
	text.slice(0, func) +
	`
  (global $gmux.stack_low (mut i32) (i32.const 0))
  (global $gmux.stack_size (mut i32) (i32.const -1))
  (func $gmux.set_stack_limits (export "__gmux_set_stack_limits") (param $high i32) (param $low i32)
    local.get $low
    global.set $gmux.stack_low
    local.get $high
    local.get $low
    i32.sub
    global.set $gmux.stack_size)` +
	text.slice(func);
// one unsigned comparison covers both ends: sp - low wraps above the size when sp is below low
const check = (ind: string) =>
	[
		'local.tee $gmux.sp',
		'global.get $gmux.stack_low',
		'i32.sub',
		'global.get $gmux.stack_size',
		'i32.gt_u',
		'if (result i32)',
		'  local.get $gmux.sp',
		'  call $gmux.stack_move',
		'else',
		'  local.get $gmux.sp',
		'end'
	]
		.map((l) => ind + l)
		.join('\n');
const SWITCHERS = ['$__wasm_crtjmp'];
const GUARD = 4096;
const count = (s: string, c: string) => s.split(c).length - 1;
const lines = text.split('\n');
// functions that call nothing, by the line their header is on
const leaf = new Map<number, boolean>();
let header: number | null = null;
lines.forEach((line, n) => {
	if (line.startsWith('  (func ')) {
		header = n;
		leaf.set(n, true);
	} else if (header !== null && /^(call |call_indirect|return_call)/.test(line.trimStart()))
		leaf.set(header, false);
});
header = null;
const out: string[] = [];
let checks = 0;
let switcher = false;
lines.forEach((line, n) => {
	const s = line.trimStart();
	if (line.startsWith('  (func ')) {
		header = n;
		const name = line.trim().split(/\s+/)[1] ?? '';
		switcher = line.startsWith('  (func $gmux.') || SWITCHERS.includes(name);
		out.push(line);
		if (!switcher && count(line, '(') !== count(line, ')'))
			out.push('    (local $gmux.sp i32)');
		return;
	}
	out.push(line);
	// a subtraction whose result goes, through at most one local.tee, into the stack pointer
	if (switcher || !s.startsWith('i32.sub')) return;
	const ahead = lines.slice(n + 1, n + 3).map((l) => l.trimStart());
	const small = (lines[n - 1] ?? '').trimStart().match(/^i32\.const (\d+)$/);
	if (header !== null && leaf.get(header) && small && Number(small[1]) <= GUARD) return;
	if (
		ahead[0]?.startsWith('global.set $__stack_pointer') ||
		(ahead.length === 2 &&
			ahead[0]!.startsWith('local.tee ') &&
			ahead[1]!.startsWith('global.set $__stack_pointer'))
	) {
		out.push(check(line.slice(0, line.length - s.length)));
		checks++;
	}
});
writeFileSync(dst!, out.join('\n'));
console.log(`checked ${checks} frame allocations`);
