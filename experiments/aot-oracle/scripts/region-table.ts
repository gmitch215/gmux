import { readFileSync } from 'node:fs';

/**
 * Reads region-time.sh (x86), region-wasm.ts (V8) and region.sh's counts and prints, per arm and form, `r`
 * (time over the binary) and `c`, the multiplier of the lifted part alone: the arm's time less the
 * interpreted share of the interpreter-alone time, over the same share of the binary's time. The interpreted
 * ops are assumed to cost what an average interpreted op costs; a first run is read against the same
 * interpreter-alone median.
 *
 * `region-table.ts <counts.csv> <native.log> <wasm.log>...`; with no native.log the wasm rows use `binary` from none
 * and print no r
 */
export interface Row {
	arm: string;
	first?: number;
	ms: number;
}

const cells = (line: string) =>
	line
		.replace(/^\d\d:\d\d:\d\d load1 [\d.]+ /, '')
		.split('|')
		.slice(1, -1)
		.map((c) => c.trim());

/** region-time.sh rows: | arm | ms per run | median ms | spread | r | load1 | */
export function parseNative(text: string): Row[] {
	return text
		.split('\n')
		.map(cells)
		.filter((c) => c.length === 6 && /^\d+$/.test(c[2]!))
		.map((c) => ({ arm: c[0]!, ms: Number(c[2]) }));
}

/** region-wasm.ts rows: | workload | arm | first ms | later ms | median ms | spread | md5 | loads | rss | */
export function parseWasm(text: string): Row[] {
	return text
		.split('\n')
		.map(cells)
		.filter((c) => c.length === 9 && /^\d+$/.test(c[2]!) && /^\d+$/.test(c[4]!))
		.map((c) => ({ arm: c[1]!, first: Number(c[2]), ms: Number(c[4]) }));
}

/** region.sh rows: workload,arm,regs,output,insns,rd,wr,lifted%,entries,rss -> the lifted share per `arm:form` */
export function parseCounts(text: string): Map<string, { lifted: number; entries: number }> {
	const out = new Map<string, { lifted: number; entries: number }>();
	for (const line of text.split('\n')) {
		const f = line.split(',');
		if (f.length !== 10 || f[3] !== 'exact') continue;
		out.set(`${f[1]}:${f[2]}`, { lifted: parseFloat(f[7]!) / 100, entries: Number(f[8]) });
	}
	return out;
}

export interface Line {
	arm: string;
	r: number | null;
	rFirst: number | null;
	lifted: number;
	c: number | null;
	cFirst: number | null;
}

export function table(rows: Row[], counts: Map<string, { lifted: number; entries: number }>, native: number | null): Line[] {
	const interp = rows.find((r) => r.arm === 'interp' || r.arm === 'int');
	return rows
		.filter((r) => counts.has(r.arm) || r === interp)
		.map((r) => {
			const p = counts.get(r.arm)?.lifted ?? 0;
			const region = (ms: number) => (interp && native && p > 0 ? (ms - (1 - p) * interp.ms) / (p * native) : null);
			return {
				arm: r.arm,
				r: native ? r.ms / native : null,
				rFirst: native && r.first ? r.first / native : null,
				lifted: p,
				c: region(r.ms),
				cFirst: r.first ? region(r.first) : null
			};
		});
}

if (process.argv[1]?.endsWith('region-table.ts')) {
	const [countsPath = '', nativePath = '', ...wasm] = process.argv.slice(2);
	const counts = parseCounts(readFileSync(countsPath, 'utf8'));
	const nativeRows = nativePath ? parseNative(readFileSync(nativePath, 'utf8')) : [];
	const binary = nativeRows.find((r) => r.arm === 'binary')?.ms ?? null;
	const f = (v: number | null) => (v === null ? '-' : v.toFixed(2));
	console.log('| host | arm | lifted | r | r first run | c | c first run |');
	console.log('| --- | --- | --- | --- | --- | --- | --- |');
	for (const l of table(nativeRows, counts, binary))
		console.log(`| x86 | ${l.arm} | ${(100 * l.lifted).toFixed(1)}% | ${f(l.r)} | - | ${f(l.c)} | - |`);
	for (const path of wasm)
		for (const l of table(parseWasm(readFileSync(path, 'utf8')), counts, binary))
			console.log(`| ${path} | ${l.arm} | ${(100 * l.lifted).toFixed(1)}% | ${f(l.r)} | ${f(l.rFirst)} | ${f(l.c)} | ${f(l.cFirst)} |`);
}
