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
	'\n  (global $gmux.budget (mut i32) (i32.const 100000))' +
	text.slice(func);
const check = (ind: string) =>
	[
		'global.get $gmux.budget',
		'i32.const 1',
		'i32.sub',
		'global.set $gmux.budget',
		'global.get $gmux.budget',
		'i32.const 0',
		'i32.lt_s',
		'if',
		'  call $gmux.fuel',
		'  global.set $gmux.budget',
		'end'
	]
		.map((l) => ind + l)
		.join('\n');
const out: string[] = [];
let loops = 0;
for (const line of text.split('\n')) {
	out.push(line);
	const s = line.trimStart();
	if (s.startsWith('loop') && (s.length === 4 || ' ;'.includes(s[4]!))) {
		out.push(check(line.slice(0, line.length - s.length) + '  '));
		loops++;
	}
}
writeFileSync(dst!, out.join('\n'));
console.log(`instrumented ${loops} loops`);
