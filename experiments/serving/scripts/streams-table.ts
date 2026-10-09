import { readFileSync } from 'node:fs';

/**
 * The table of streams.sh's cells: per kernel and workload the guest's free memory once K stalled
 * readers have stopped moving it, the drop per stream, and a least-squares fit of free memory
 * against K over the cells where every stream got its 200 and the OOM killer stayed quiet. The cap is
 * floor((free after boot - FLOOR_KB) / kB per stream), once from the machine's free memory at boot
 * and once from the fit's free memory at zero streams (which carries the rig's own 6.9 MB file).
 * `node --experimental-strip-types streams-table.ts <cells.jsonl> [floor kB]`
 */
export interface Cell {
	kernel: string;
	workload: string;
	k: number;
	freeBoot?: number;
	free0?: number;
	freeSteady?: number;
	freeAfterAbort?: number;
	ok?: number;
	oom?: string | null;
	shellDead?: boolean;
	tasks0?: number;
	tasks?: number;
	statuses?: string[];
	failed?: boolean;
}

const f = (n: number | undefined, d = 0) =>
	n === undefined || !Number.isFinite(n) ? '-' : n.toFixed(d);

/** free = a - b k through the points, by least squares; `worst` is the largest miss in kB */
export function fit(points: [number, number][]) {
	const n = points.length;
	const mx = points.reduce((s, [x]) => s + x, 0) / n;
	const my = points.reduce((s, [, y]) => s + y, 0) / n;
	const sxx = points.reduce((s, [x]) => s + (x - mx) ** 2, 0);
	const sxy = points.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0);
	const slope = sxx ? sxy / sxx : 0;
	const a = my - slope * mx;
	const worst = Math.max(...points.map(([x, y]) => Math.abs(y - (a + slope * x))));
	return { a, perStream: -slope, worst };
}

const clean = (c: Cell) =>
	c.k > 0 && c.ok === c.k && !c.oom && !c.shellDead && c.freeSteady !== undefined;

/** markdown lines for the text of a streams.sh cells file */
export function streamsReport(jsonl: string, floorKb = 4096): string[] {
	const cells = jsonl
		.split('\n')
		.filter((line) => line.startsWith('{'))
		.map((line) => JSON.parse(line) as Cell);
	const out: string[] = [];
	const groups = new Map<string, Cell[]>();
	for (const c of cells) {
		const key = `${c.kernel} | ${c.workload}`;
		groups.set(key, [...(groups.get(key) ?? []), c]);
	}
	for (const [key, rows] of groups) {
		const [kernel, workload] = key.split(' | ');
		rows.sort((a, b) => a.k - b.k);
		const base = rows.find((c) => c.k === 0)?.freeSteady;
		out.push(
			`### ${kernel}, ${workload}`,
			'',
			'| k | free after steady kB | drop vs k=0 kB | kB per stream | streams with 200 | tasks added | OOM | free after abort kB |',
			'| --- | --- | --- | --- | --- | --- | --- | --- |'
		);
		for (const c of rows) {
			if (c.failed) {
				out.push(`| ${c.k} | cell failed | | | | | | |`);
				continue;
			}
			const drop = base === undefined ? undefined : base - c.freeSteady!;
			out.push(
				`| ${c.k} | ${f(c.freeSteady)} | ${f(drop)} | ${c.k ? f(drop! / c.k, 1) : '-'} | ${c.ok}/${c.k} | ${f((c.tasks ?? NaN) - (c.tasks0 ?? NaN))} | ${c.shellDead ? 'shell dead' : (c.oom ?? 'none')} | ${f(c.freeAfterAbort)} |`
			);
		}
		const good = rows.filter(clean);
		if (good.length < 2) {
			out.push('', 'fit: fewer than two clean cells', '');
			continue;
		}
		const { a, perStream, worst } = fit(good.map((c) => [c.k, c.freeSteady!]));
		const boot = rows.find((c) => c.freeBoot !== undefined)?.freeBoot;
		out.push(
			'',
			`fit over k = ${good.map((c) => c.k).join(', ')}: ${f(perStream, 1)} kB per stream, ${f(a)} kB free at zero streams, worst miss ${f(worst)} kB`
		);
		out.push(
			`cap from the rig's free memory at zero streams: floor((${f(a)} - ${floorKb}) / ${f(perStream, 1)}) = ${Math.floor((a - floorKb) / perStream)}`
		);
		if (boot !== undefined)
			out.push(
				`cap from free memory at boot: floor((${f(boot)} - ${floorKb}) / ${f(perStream, 1)}) = ${Math.floor((boot - floorKb) / perStream)}`
			);
		out.push('');
	}
	return out;
}

if (import.meta.main) {
	const path = process.argv[2];
	if (!path) {
		console.error('usage: streams-table.ts <cells.jsonl> [floor kB]');
		process.exit(2);
	}
	console.log(
		streamsReport(readFileSync(path, 'utf8'), Number(process.argv[3] ?? 4096)).join('\n')
	);
}
