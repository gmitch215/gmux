import { readFileSync } from 'node:fs';

/**
 * region.sh's counts-extra.csv and counts-epochs.csv as what the epoch form of a region removes: per 1,000 guest
 * instructions, the generation compares (a window resolve and a checked access each made one) and the
 * pending-flag reads at back edges before, against the epoch compare at each region entry and the epoch test at
 * each back edge after. An arm named `<arm>+ep` is paired with `<arm>`; the last row of an arm and form wins.
 *
 * `epochs-regions.ts <out dir>...` (each holding both csv files)
 */
export interface Row {
	workload: string;
	arm: string;
	regs: string;
	insns: number;
	entries: number;
	winEnter: number;
	chkAcc: number;
	polls: number;
	epIn: number;
	epSlow: number;
	epBack: number;
}

export function parseRows(extra: string, epochs: string): Row[] {
	const rows = new Map<string, Row>();
	const num = (v: string | undefined) => (v !== undefined && /^\d+$/.test(v) ? Number(v) : undefined);
	for (const line of extra.split('\n')) {
		const f = line.split(',');
		const n = f.slice(3).map(num);
		if (f.length !== 12 || n.includes(undefined)) continue;
		rows.set(`${f[0]}:${f[1]}:${f[2]}`, {
			workload: f[0]!,
			arm: f[1]!,
			regs: f[2]!,
			insns: n[0]!,
			entries: n[1]!,
			winEnter: n[3]!,
			chkAcc: n[5]!,
			polls: n[8]!,
			epIn: 0,
			epSlow: 0,
			epBack: 0
		});
	}
	for (const line of epochs.split('\n')) {
		const f = line.split(',');
		const n = f.slice(3).map(num);
		const row = rows.get(`${f[0]}:${f[1]}:${f[2]}`);
		if (f.length !== 7 || n.includes(undefined) || !row) continue;
		row.epIn = n[1]!;
		row.epSlow = n[2]!;
		row.epBack = n[3]!;
	}
	return [...rows.values()];
}

const k = (v: number, insns: number) => ((1000 * v) / insns).toFixed(1);

/** one line per workload, arm and form that has both a plain and a `+ep` row */
export function table(rows: Row[]): string[] {
	const out = [
		'| workload | arm | form | window resolves | checked accesses | polls | region entries | after: entry compares | after: back-edge tests | gen compares removed | checks before | checks after | removed |',
		'| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'
	];
	for (const a of rows) {
		const b = rows.find((r) => r.workload === a.workload && r.regs === a.regs && r.arm === `${a.arm}+ep`);
		if (!b) continue;
		const before = a.winEnter + a.chkAcc + a.polls;
		const after = b.epIn + b.epBack;
		out.push(
			`| ${a.workload} | ${a.arm} | ${a.regs} | ${k(a.winEnter, a.insns)} | ${k(a.chkAcc, a.insns)} | ${k(a.polls, a.insns)} | ${k(a.entries, a.insns)} | ${k(b.epIn, b.insns)} | ${k(b.epBack, b.insns)} | ${k(a.winEnter + a.chkAcc, a.insns)} | ${k(before, a.insns)} | ${k(after, b.insns)} | ${(1000 * (before / a.insns - after / b.insns)).toFixed(1)} |`
		);
	}
	return out;
}

if (process.argv[1]?.endsWith('epochs-regions.ts')) {
	const rows = process.argv.slice(2).flatMap((dir) => parseRows(readFileSync(`${dir}/counts-extra.csv`, 'utf8'), readFileSync(`${dir}/counts-epochs.csv`, 'utf8')));
	console.log(table(rows).join('\n'));
}
