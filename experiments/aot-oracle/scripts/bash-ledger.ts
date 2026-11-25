import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// a derived row states the figures it recomputes; two summed rows that overlap are refused
export interface Row {
	id: string;
	host: 'v8' | 'x86' | 'any';
	mechanism: string;
	unit: string;
	status: 'measured' | 'bounded' | 'inferred' | 'unmeasured' | 'pending';
	instrument?: string;
	source?: string;
	quote?: string;
	low?: number | null;
	high?: number | null;
	from?: string[];
	op?: 'mul' | 'sub' | 'div' | 'sum';
	factor?: number;
	baseline?: boolean;
	summed?: boolean;
	input?: boolean;
	overlaps?: string[];
	note?: string;
}

export interface Result {
	row: Row;
	low: number | null;
	high: number | null;
	pending: string | null;
}

export interface Remainder {
	host: string;
	base: Result;
	summed: Result[];
	low: number;
	high: number;
}

export interface Ledger {
	results: Result[];
	bases: Result[];
	failures: string[];
	remainders: Remainder[];
}

interface Num {
	n: number;
	d: number;
}

export function numbersIn(text: string): Num[] {
	return [...text.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => {
		const s = m[0].replaceAll(',', '');
		const dot = s.indexOf('.');
		return { n: Number(s), d: dot < 0 ? 0 : s.length - dot - 1 };
	});
}

// sources are repo-relative, so the root is the nearest package.json
export function findRoot(file: string): string {
	for (let dir = dirname(file); ; dir = dirname(dir)) {
		if (existsSync(join(dir, 'package.json'))) return dir;
		if (dirname(dir) === dir) throw new Error(`no package.json above ${file}`);
	}
}

function apply(row: Row, xs: number[]): number {
	switch (row.op) {
		case 'mul':
			return xs.reduce((a, b) => a * b, 1);
		case 'sum':
			return xs.reduce((a, b) => a + b, 0);
		case 'sub':
		case 'div':
			if (xs.length !== 2) throw new Error(`${row.id}: ${row.op} takes two inputs`);
			return row.op === 'sub' ? xs[0]! - xs[1]! : xs[0]! / xs[1]!;
		default:
			throw new Error(`${row.id}: unknown op ${String(row.op)}`);
	}
}

const decimalsOf = (v: number) => (String(v).split('.')[1] ?? '').length;

// the decimals a row states set the precision of its check
const agrees = (computed: number, stated: number) => Number(computed.toFixed(decimalsOf(stated))) === stated;

// derived figures are printed rounded; direct figures must appear exactly
const carriesRounded = (nums: Num[], v: number) => nums.some((q) => Number(v.toFixed(q.d)) === q.n);

export function evaluate(rows: Row[], root: string): Ledger {
	const failures: string[] = [];
	const byId = new Map<string, Row>();
	for (const row of rows) {
		if (byId.has(row.id)) failures.push(`${row.id}: duplicate id`);
		byId.set(row.id, row);
	}

	const texts = new Map<string, string | null>();
	const text = (rel: string): string | null => {
		if (!texts.has(rel)) texts.set(rel, existsSync(join(root, rel)) ? readFileSync(join(root, rel), 'utf8') : null);
		return texts.get(rel) ?? null;
	};

	const done = new Map<string, Result>();
	const open = new Set<string>();
	const solve = (id: string): Result => {
		const known = done.get(id);
		if (known) return known;
		const row = byId.get(id);
		if (!row) throw new Error(`unknown row id: ${id}`);
		if (open.has(id)) throw new Error(`cycle through ${id}`);
		open.add(id);
		const res = compute(row);
		open.delete(id);
		done.set(id, res);
		return res;
	};

	const compute = (row: Row): Result => {
		const res: Result = { row, low: null, high: null, pending: null };
		if (row.status === 'pending') return { ...res, pending: 'status is pending' };
		if (row.source !== undefined && text(row.source) === null)
			return { ...res, pending: `source missing: ${row.source}` };
		const src = row.source === undefined ? '' : (text(row.source) ?? '');

		if (row.from) {
			const inputs = row.from.map(solve);
			const waiting = inputs.find((i) => i.pending);
			if (waiting) return { ...res, pending: `input ${waiting.row.id} is pending` };
			if (inputs.some((i) => i.low === null || i.high === null)) {
				failures.push(`${row.id}: an input has no figure`);
				return res;
			}
			if (row.host !== 'any' && inputs.some((i) => i.row.host !== 'any' && i.row.host !== row.host))
				failures.push(`${row.id}: an input is on another host`);
			const factor = row.factor ?? 1;
			res.low = apply(row, inputs.map((i) => i.low!)) * factor;
			res.high = apply(row, inputs.map((i) => i.high!)) * factor;
			if (row.low == null || row.high == null) failures.push(`${row.id}: derived row states no figure`);
			else {
				if (!agrees(res.low, row.low)) failures.push(`${row.id}: low recomputes to ${res.low}, states ${row.low}`);
				if (!agrees(res.high, row.high)) failures.push(`${row.id}: high recomputes to ${res.high}, states ${row.high}`);
			}
			if (row.quote !== undefined) {
				if (!src.includes(row.quote)) failures.push(`${row.id}: quote not found in ${row.source}`);
				else if (!carriesRounded(numbersIn(row.quote), res.low)) failures.push(`${row.id}: quote does not carry ${res.low}`);
			}
			return res;
		}

		if (row.quote !== undefined) {
			if (row.source === undefined) failures.push(`${row.id}: quote has no source`);
			else if (!src.includes(row.quote)) failures.push(`${row.id}: quote not found in ${row.source}`);
		}
		if (row.low == null && row.high == null) {
			if (row.status !== 'unmeasured') failures.push(`${row.id}: ${row.status} row has no figure`);
			return res;
		}
		if (row.low == null || row.high == null) failures.push(`${row.id}: low and high must both be set`);
		if (row.quote === undefined) failures.push(`${row.id}: figure has no quote`);
		const nums = numbersIn(row.quote ?? '');
		for (const v of [row.low, row.high]) {
			if (v != null && !nums.some((q) => q.n === v)) failures.push(`${row.id}: ${v} not in quote`);
		}
		res.low = row.low ?? null;
		res.high = row.high ?? null;
		return res;
	};

	const results = rows.map((row) => solve(row.id));

	const overlap = new Map<string, Set<string>>();
	const link = (a: string, b: string) => {
		overlap.set(a, (overlap.get(a) ?? new Set<string>()).add(b));
	};
	for (const row of rows) {
		for (const other of row.overlaps ?? []) {
			if (!byId.has(other)) failures.push(`${row.id}: overlaps unknown row ${other}`);
			link(row.id, other);
			link(other, row.id);
		}
	}

	const summed = results.filter((r) => r.row.summed && !r.pending && !r.row.baseline);
	for (let i = 0; i < summed.length; i++) {
		for (let j = i + 1; j < summed.length; j++) {
			const a = summed[i]!.row.id;
			const b = summed[j]!.row.id;
			if (overlap.get(a)?.has(b)) throw new Error(`refusing to sum ${a} and ${b}: overlaps: [${a}, ${b}]`);
		}
	}
	for (const r of summed) {
		if (r.row.unit !== 'ms') failures.push(`${r.row.id}: summed row is in ${r.row.unit}, not ms`);
		if (r.row.host === 'any') failures.push(`${r.row.id}: an any-host row cannot be summed`);
	}

	const bases = results.filter((r) => r.row.baseline && !r.pending && r.low !== null && r.high !== null);
	const remainders: Remainder[] = [];
	for (const base of bases) {
		const mine = summed.filter((r) => r.row.host === base.row.host && r.row.unit === 'ms' && r.row.host !== 'any');
		const sumLow = mine.reduce((s, r) => s + r.low!, 0);
		const sumHigh = mine.reduce((s, r) => s + r.high!, 0);
		remainders.push({
			host: base.row.host,
			base,
			summed: mine,
			low: base.low! - sumHigh,
			high: base.high! - sumLow
		});
	}
	return { results, bases, failures, remainders };
}

const fmt = (x: number) => x.toLocaleString('en-US', { maximumFractionDigits: 3 });
const span = (low: number, high: number, suffix: string) =>
	low === high ? `${fmt(low)}${suffix}` : `${fmt(low)}${suffix} to ${fmt(high)}${suffix}`;

export function render(ledger: Ledger): string {
	const out = [
		'| id | host | mechanism | value | share of baseline | status | summed | instrument | source |',
		'| --- | --- | --- | --- | --- | --- | --- | --- | --- |'
	];
	for (const r of ledger.results) {
		const { row } = r;
		const base = ledger.bases.find((b) => b.row.host === row.host);
		let value = 'unmeasured';
		if (r.pending) value = `pending (${r.pending})`;
		else if (r.low !== null && r.high !== null) value = span(r.low, r.high, ` ${row.unit}`);
		let share = '-';
		if (!r.pending && !row.input && row.unit === 'ms' && base && r.low !== null && r.high !== null) {
			const pct = (x: number) => ((100 * x) / base.low!).toFixed(1);
			share = pct(r.low) === pct(r.high) ? `${pct(r.low)}%` : `${pct(r.low)}% to ${pct(r.high)}%`;
		}
		const cells = [
			row.id,
			row.host,
			row.mechanism,
			value,
			share,
			row.status,
			row.summed && !r.pending ? 'yes' : 'no',
			row.instrument ?? (row.from ? `derived from ${row.from.join(', ')}` : '-'),
			row.source ?? '-'
		];
		out.push(`| ${cells.join(' | ')} |`);
	}

	out.push('', '## Remainder', '');
	for (const rem of ledger.remainders) {
		const names = rem.summed.map((s) => s.row.id).join(', ') || 'none';
		out.push(
			`- ${rem.host}: ${span(rem.low, rem.high, '')} ms unattributed (baseline ${span(rem.base.low!, rem.base.high!, '')} ms less ${names})`
		);
	}

	const pending = ledger.results.filter((r) => r.pending);
	if (pending.length) {
		out.push('', '## Pending', '');
		for (const r of pending) out.push(`- ${r.row.id}: ${r.pending}`);
	}
	if (ledger.failures.length) {
		out.push('', '## Failures', '');
		for (const f of ledger.failures) out.push(`- ${f}`);
	}
	out.push('', `Rows: ${ledger.results.length}. Pending: ${pending.length}. Failures: ${ledger.failures.length}.`);
	return out.join('\n');
}

if (process.argv[1]?.endsWith('bash-ledger.ts')) {
	const args = process.argv.slice(2);
	const [path] = args.filter((a) => !a.startsWith('--'));
	if (!path) {
		console.error('usage: bash-ledger.ts <rows.json> [--check]');
		process.exit(2);
	}
	const file = resolve(path);
	try {
		const ledger = evaluate(JSON.parse(readFileSync(file, 'utf8')) as Row[], findRoot(file));
		console.log(render(ledger));
		if (args.includes('--check') && ledger.failures.length) process.exit(1);
	} catch (e) {
		console.error((e as Error).message);
		process.exit(1);
	}
}
