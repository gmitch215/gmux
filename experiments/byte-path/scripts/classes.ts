import { readFileSync, writeFileSync } from 'node:fs';

/**
 * the small kernel functions whose body holds memory.copy or memory.fill, from `wasm-tools print vmlinux.wasm`
 * (a kernel has no name section; an index is what the profiler prints). Writes a json for split.ts's CLASSES
 * `node --experimental-strip-types classes.ts <vmlinux.wat> <out.json> [max lines, 150]`
 */
const [wat, out, max = '150'] = process.argv.slice(2);
if (!wat || !out) throw new Error('usage: classes.ts <vmlinux.wat> <out.json> [max lines]');
const lines = readFileSync(wat, 'utf8').split('\n');
const copy: number[] = [];
const fill: number[] = [];
const sizes: Record<string, number> = {};
let index = -1;
let start = 0;
const close = (end: number) => {
	if (index < 0) return;
	const body = lines.slice(start, end);
	if (body.length > Number(max)) return;
	const hasCopy = body.some((l) => l.includes('memory.copy'));
	const hasFill = body.some((l) => l.includes('memory.fill'));
	if (hasCopy) copy.push(index);
	else if (hasFill) fill.push(index);
	if (hasCopy || hasFill) sizes[index] = body.length;
};
lines.forEach((line, n) => {
	const m = /^ {2}\(func \(;(\d+);\)/.exec(line);
	if (!m) return;
	close(n);
	index = Number(m[1]);
	start = n;
});
close(lines.length);
writeFileSync(out, JSON.stringify({ copy, fill, sizes }));
console.log(`copy ${copy.length} fill ${fill.length}`);
