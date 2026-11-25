import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { branches, hinted } from './branch-hint.ts';

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
	writeFileSync(out, hinted(readFileSync(out), entries, 0));
	console.log(`hint: ${entries.map((e) => `func ${e.index} ${JSON.stringify(e.hints)}`).join(', ')}`);
}
console.log(`built ${Object.keys(modules).join(', ')}`);
