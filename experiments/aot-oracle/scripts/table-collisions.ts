import { readFileSync } from 'node:fs';

/**
 * The blocks of one lifted table whose pc occurs for more than one ELF: `table-collisions.ts <lifted.c> <regions>:<elf>,...`
 * (regions as `3` or `3-26`, in the order the lifter was given its dumps). A pair at one pc is a collision the attach
 * guard alone must tell apart; it is `equal` when next, target, op count and every op's IR agree, so only the
 * instruction boundaries (pcs) differ
 */
const [file = '', labels = ''] = process.argv.slice(2);
if (!file || !labels) {
	console.error('usage: table-collisions.ts <lifted.c> <regions>:<elf>,...');
	process.exit(2);
}
const text = readFileSync(file, 'utf8');
const elfOf = new Map<number, string>();
for (const part of labels.split(',')) {
	const [range = '', name = ''] = part.split(':');
	const [lo = '', hi = lo] = range.split('-');
	for (let r = Number(lo); r <= Number(hi); r++) elfOf.set(r, name);
}
const arrays = new Map<string, string>();
for (const m of text.matchAll(/static const struct kb_ins (\w+)\[\] = \{([\s\S]*?)\n\};/g)) arrays.set(m[1]!, m[2]!);
const tableText = /aot_table\[\] = \{([\s\S]*?)\n\};/.exec(text)?.[1] ?? '';
type Entry = { pc: string; next: string; target: string; n: number; region: number; name: string; pcs: string };
const entries: Entry[] = [];
for (const m of tableText.matchAll(/\{(0x[0-9a-f]+)ull, (0x[0-9a-f]+)ull, (0x[0-9a-f]+)ull, (\d+), (\d+), (\d+), (\w+), (\w+)\}/g))
	entries.push({ pc: m[1]!, next: m[2]!, target: m[3]!, n: Number(m[4]), region: Number(m[5]), name: m[7]!, pcs: m[8]! });
const byPc = new Map<string, Entry[]>();
for (const e of entries) byPc.set(e.pc, [...(byPc.get(e.pc) ?? []), e]);
let cross = 0;
let equal = 0;
let sameElf = 0;
const perElf = new Map<string, number>();
for (const e of entries) perElf.set(elfOf.get(e.region) ?? '?', (perElf.get(elfOf.get(e.region) ?? '?') ?? 0) + 1);
for (const [, es] of byPc) {
	if (es.length < 2) continue;
	const elfs = new Set(es.map((e) => elfOf.get(e.region)));
	if (elfs.size < 2) {
		sameElf++;
		continue;
	}
	cross++;
	const first = es.find((e) => elfOf.get(e.region) !== elfOf.get(es[0]!.region));
	const a = es[0]!;
	if (first && first.next === a.next && first.target === a.target && first.n === a.n && arrays.get(first.name) === arrays.get(a.name)) equal++;
}
console.log(`${entries.length} entries, ${byPc.size} distinct pcs; per ELF: ${[...perElf].map(([k, v]) => `${k} ${v}`).join(', ')}`);
console.log(`pcs in more than one ELF: ${cross} (equal next, target, ops and IR: ${equal}); pcs in two regions of one ELF: ${sameElf}`);
