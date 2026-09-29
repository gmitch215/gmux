import { readFileSync } from 'node:fs';

/**
 * Prints one decision's results as a table: per arm, the mean of each field over its runs with the
 * min-max beside it. Wakes and rows are per virtual day at the run's rate; the Free day is
 * 100,000 requests, 100,000 rows written and 13,000 GB-s.
 * `node --no-warnings --experimental-strip-types experiments/decisions/scripts/table.ts d1`
 */
const file = new URL(`../results/${process.argv[2]}.jsonl`, import.meta.url).pathname;
interface Summary {
	alarmEvents: number;
	ranEvents: number;
	restoredEvents: number;
	wallMsMean: number | null;
	rowsMean: number | null;
	rowsTotal: number;
	wakesPerDay: number;
	virtualHours: number;
	guest: string;
	probes: { count: number; wallMs: number };
	steady: { events: number; wakesPerDay: number; wallMsMean: number | null; rowsPerDay: number; gbSecondsPerDay: number };
	error?: string;
}
const rows = readFileSync(file, 'utf8')
	.split('\n')
	.filter(Boolean)
	.map((l) => JSON.parse(l) as { arm: string; rep: number; summary: Summary });
const byArm = new Map<string, Summary[]>();
for (const r of rows) byArm.set(r.arm, [...(byArm.get(r.arm) ?? []), r.summary]);

const guestN = (s: Summary) => {
	if (s.guest.startsWith('unread')) return NaN;
	const first = s.guest.split(' / ')[0]?.trim().split(' ')[0];
	return first ? Number(first) : 0;
};
const guestOk = (s: Summary) => {
	const [n, sum] = (s.guest.split(' / ')[0] ?? '').trim().split(' ');
	if (sum === undefined) return n === undefined || n === '' ? 'no file' : `bad ${n}`;
	if (Number.isFinite(Number(sum)) && n && sum.length > 2) {
		const want = (BigInt(n) * (BigInt(n) + 1n)) / 2n;
		return BigInt(sum) === want ? 'sum ok' : 'SUM WRONG';
	}
	return sum === '0' ? 'md5 ok' : `bad ${sum}`;
};
const stat = (xs: number[], digits = 1) => {
	const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
	const f = (v: number) => (Math.round(v * 10 ** digits) / 10 ** digits).toString();
	return Math.min(...xs) === Math.max(...xs) ? f(mean) : `${f(mean)} (${f(Math.min(...xs))}-${f(Math.max(...xs))})`;
};
const fit = (s: Summary) => {
	const { wakesPerDay, rowsPerDay, gbSecondsPerDay } = s.steady;
	const limits = [100_000 / wakesPerDay, 100_000 / rowsPerDay, 13_000 / gbSecondsPerDay].filter(Number.isFinite);
	return limits.length ? Math.floor(Math.min(...limits)) : null;
};
const whole: [string, (s: Summary) => number | null, number?][] = [
	['alarm events', (s) => s.alarmEvents, 0],
	['ran', (s) => s.ranEvents, 0],
	['wall ms/event (virtual)', (s) => s.wallMsMean],
	['rows/event', (s) => s.rowsMean, 2],
	['GB-s per event x1000', (s) => (s.wallMsMean === null ? null : s.wallMsMean * 0.128)],
	['guest n', (s) => guestN(s), 0],
	['n per ran event', (s) => (s.ranEvents ? guestN(s) / s.ranEvents : null), 2]
];
const steadyCols: [string, (s: Summary) => number | null, number?][] = [
	['alarm events', (s) => s.alarmEvents, 0],
	['restored', (s) => s.restoredEvents, 0],
	['steady wakes/day', (s) => s.steady.wakesPerDay, 0],
	['steady rows/day', (s) => s.steady.rowsPerDay, 0],
	['wall ms/wake (virtual)', (s) => s.steady.wallMsMean],
	['GB-s/day (virtual wall)', (s) => s.steady.gbSecondsPerDay],
	['machines/Free day', fit, 0],
	['guest n', (s) => guestN(s), 0]
];
const cols = process.argv[2] === 'd2' ? whole : steadyCols;
console.log(['arm', 'runs', ...cols.map((c) => c[0]), 'guest check'].join(' | '));
for (const [arm, sums] of byArm) {
	const ok = sums.filter((s) => !s.error);
	if (!ok.length) {
		console.log(`${arm} | ${sums.length} | ERROR ${sums[0]?.error}`);
		continue;
	}
	console.log(
		[
			arm,
			ok.length,
			...cols.map(([, f, d]) => {
				const xs = ok.map(f).filter((v): v is number => v !== null && Number.isFinite(v));
				return xs.length ? stat(xs, d ?? 1) : '-';
			}),
			[...new Set(ok.map(guestOk))].join('/')
		].join(' | ')
	);
}
