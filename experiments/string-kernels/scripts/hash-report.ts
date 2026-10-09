import { readFileSync } from 'node:fs';

/**
 * Tables of hash-run.sh's samples.tsv (native Katybug against native coreutils) and hash-wasm.ts's samples
 * (a machine under V8): per cell the samples kept, wall median and range, MB/s, the spread of the layouts' medians
 * and the highest quiet reading (above 0.5 a sample is a smoke run); then r, the arm's median wall over the native
 * one, whole and net of the arm's own 0-byte start-up.
 * `node --experimental-strip-types hash-report.ts native|v8 <samples.tsv>`
 */
const MIB: Record<string, number> = { in0: 0, in1: 1, in64: 64, in512: 512 };
const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]!;
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
const f = (n: number, d = 3) => (Number.isFinite(n) ? n.toFixed(d) : '-');
const lines = (tsv: string) =>
	tsv
		.trim()
		.split('\n')
		.slice(1)
		.map((l) => l.split('\t'));

interface Cell {
	wall: number[];
	layouts: Map<string, number[]>;
	quiet: number;
	smoke: number;
	failed: number;
}

/** markdown rows for the text of a hash-run.sh samples.tsv */
export function nativeReport(tsv: string): string[] {
	const cells = new Map<string, Cell>();
	for (const r of lines(tsv)) {
		const [tool, input, arm, layout, , wall, , , , , , , q0, q1, ok] = r as string[];
		const key = [tool, input, arm].join('\t');
		const c = cells.get(key) ?? { wall: [], layouts: new Map(), quiet: 0, smoke: 0, failed: 0 };
		const w = Number(wall);
		c.wall.push(w);
		c.layouts.set(layout!, [...(c.layouts.get(layout!) ?? []), w]);
		const q = Math.max(Number(q0), Number(q1));
		c.quiet = Math.max(c.quiet, q);
		if (q > 0.5) c.smoke++;
		if (ok !== '1') c.failed++;
		cells.set(key, c);
	}
	const out = ['| tool | input | arm | n | wall median s | min-max | MB/s | layout spread | max quiet | smoke | failed |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
	for (const [key, c] of cells) {
		const [tool, input, arm] = key.split('\t') as [string, string, string];
		const m = median(c.wall);
		const lm = [...c.layouts.values()].map(median);
		const spread = lm.length > 1 ? ((Math.max(...lm) - Math.min(...lm)) / mean(lm)) * 100 : NaN;
		const rate = MIB[input] ? (MIB[input]! * 1.048576) / m : NaN;
		out.push(`| ${tool} | ${input} | ${arm} | ${c.wall.length} | ${f(m)} | ${f(Math.min(...c.wall))}-${f(Math.max(...c.wall))} | ${f(rate, 1)} | ${f(spread, 1)}${Number.isFinite(spread) ? '%' : ''} | ${f(c.quiet, 2)} | ${c.smoke} | ${c.failed} |`);
	}
	const med = (t: string, i: string, a: string) => {
		const c = cells.get([t, i, a].join('\t'));
		return c ? median(c.wall) : NaN;
	};
	out.push('', '| tool | input | arm | wall r | r net of start-up | start-up s (arm / native) |', '| --- | --- | --- | --- | --- | --- |');
	for (const tool of new Set([...cells.keys()].map((k) => k.split('\t')[0]!)))
		for (const input of ['in1', 'in64', 'in512'])
			for (const arm of ['off', 'kernel']) {
				const w = med(tool, input, arm);
				const n = med(tool, input, 'native');
				if (!Number.isFinite(w) || !Number.isFinite(n)) continue;
				const a0 = med(tool, 'in0', arm);
				const n0 = med(tool, 'in0', 'native');
				out.push(`| ${tool} | ${input} | ${arm} | ${f(w / n, 2)} | ${f((w - a0) / (n - n0), 2)} | ${f(a0)} / ${f(n0)} |`);
			}
	return out;
}

/** markdown rows for the text of a hash-wasm.ts samples file (milliseconds) */
export function v8Report(tsv: string): string[] {
	const cells = new Map<string, number[]>();
	const quiet = new Map<string, number>();
	const failed = new Map<string, number>();
	for (const r of lines(tsv)) {
		const [arm, tool, mib, , ms, q0, q1, ok] = r as string[];
		const key = [arm, tool, mib].join('\t');
		cells.set(key, [...(cells.get(key) ?? []), Number(ms) / 1000]);
		quiet.set(key, Math.max(quiet.get(key) ?? 0, Number(q0), Number(q1)));
		failed.set(key, (failed.get(key) ?? 0) + (ok === '1' ? 0 : 1));
	}
	const med = (arm: string, tool: string, mib: number) => {
		const v = cells.get([arm, tool, mib].join('\t'));
		return v ? median(v) : NaN;
	};
	const out = ['| arm | tool | MiB | n | wall median s | min-max | MB/s | max quiet | failed |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
	for (const [key, v] of cells) {
		const [arm, tool, mib] = key.split('\t') as [string, string, string];
		const m = median(v);
		out.push(`| ${arm} | ${tool} | ${mib} | ${v.length} | ${f(m)} | ${f(Math.min(...v))}-${f(Math.max(...v))} | ${Number(mib) ? f((Number(mib) * 1.048576) / m, 1) : '-'} | ${f(quiet.get(key)!, 2)} | ${failed.get(key)} |`);
	}
	out.push('', '| tool | MiB | arm | wall r | r net of start-up | r net of the read floor |', '| --- | --- | --- | --- | --- | --- |');
	for (const tool of new Set([...cells.keys()].map((k) => k.split('\t')[1]!)).values())
		for (const mib of [1, 64, 512])
			for (const arm of ['off', 'kernel']) {
				const w = med(arm, tool, mib);
				const n = med('native', tool, mib);
				if (!Number.isFinite(w) || !Number.isFinite(n)) continue;
				const net = (w - med(arm, tool, 0)) / (n - med('native', tool, 0));
				const floor = (w - med('gen-guest', 'dd', mib)) / (n - med('gen-native', 'dd', mib));
				out.push(`| ${tool} | ${mib} | ${arm} | ${f(w / n, 2)} | ${f(net, 2)} | ${f(floor, 2)} |`);
			}
	return out;
}

if (process.argv[1]?.endsWith('hash-report.ts')) {
	const [kind = '', file = ''] = process.argv.slice(2);
	console.log((kind === 'v8' ? v8Report : nativeReport)(readFileSync(file, 'utf8')).join('\n'));
}
