import { readFileSync } from 'node:fs';

/**
 * The crossing table of counts.sh: per workload and import, the median count of the runs with its
 * range, and crossings per 100 KiB of console output, ring off against ring on.
 * `node --no-warnings --experimental-strip-types experiments/event-batching/scripts/counts.ts <counts.jsonl>`
 */
const file = process.argv[2];
if (!file) throw new Error('usage: counts.ts <counts.jsonl>');
type Cross = { count: number; per100KiB: number | null; perSecond: number };
type Out = {
	workload: string;
	ring: boolean | string;
	consoleBytes: number;
	outputSha: string;
	stdoutWrites: number;
	crossings: Record<string, Cross>;
	writeCalls: Cross;
	consoleDrainPeak: number;
	crashed: string;
};
const lines = readFileSync(file, 'utf8')
	.split('\n')
	.filter((l) => l.startsWith('{'))
	.map((l) => JSON.parse(l) as { run: number; loadavg: string; quiet?: string; out: Out | null });
const median = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};
const span = (xs: number[]) => {
	const [lo, hi] = [Math.min(...xs), Math.max(...xs)];
	return lo === hi ? `${lo}` : `${median(xs)} (${lo}-${hi})`;
};
const WORKLOADS = ['seq', 'cat', 'idle', 'fork', 'forkout'];
const IMPORTS = [
	'consolePuts',
	'consoleDrains',
	'pumpSteps',
	'hostSleeps',
	'userTouches',
	'userCopies',
	'userStrings',
	'idles',
	'switches',
	'relaxes',
	'fuelYields',
	'consoleReads'
];
const out: string[] = [
	'| workload | crossing | off: count | per 100 KiB | per second | on: count | per 100 KiB | per second |',
	'| --- | --- | --- | --- | --- | --- | --- | --- |'
];
const shas: string[] = [
	'| workload | console bytes (off, on) | write(2) to fd 1 | sha256 off | sha256 on | all equal |',
	'| --- | --- | --- | --- | --- | --- |'
];
for (const w of WORKLOADS) {
	const pick = (ring: boolean) =>
		lines.filter((l) => l.out?.workload === w && l.out.ring === ring).map((l) => l.out!);
	const [off, on] = [pick(false), pick(true)];
	if (!off.length || !on.length) continue;
	const cell = (runs: Out[], key: string) => {
		const get = (o: Out): Cross => (key === 'writeCalls' ? o.writeCalls : o.crossings[key]!);
		return [
			span(runs.map((o) => get(o).count)),
			span(runs.map((o) => get(o).per100KiB ?? 0)),
			span(runs.map((o) => get(o).perSecond))
		];
	};
	for (const key of [...IMPORTS, 'writeCalls']) {
		const [a, b] = [cell(off, key), cell(on, key)];
		if (a[0] === '0' && b[0] === '0') continue;
		out.push(`| ${w} | ${key} | ${a.join(' | ')} | ${b.join(' | ')} |`);
	}
	const hashes = new Set([...off, ...on].map((o) => o.outputSha));
	shas.push(
		`| ${w} | ${span(off.map((o) => o.consoleBytes))}, ${span(on.map((o) => o.consoleBytes))} | ${span(off.map((o) => o.stdoutWrites))} | ${[...new Set(off.map((o) => o.outputSha))].map((h) => h.slice(0, 16)).join(' ')} | ${[...new Set(on.map((o) => o.outputSha))].map((h) => h.slice(0, 16)).join(' ')} | ${hashes.size === 1 && [...off, ...on].every((o) => o.crashed === 'null')} |`
	);
}
console.log(out.join('\n'));
console.log();
console.log(shas.join('\n'));
console.log();
console.log(
	`runs: ${new Set(lines.map((l) => l.run)).size}; per second is host wall seconds (machine seconds for idle); load averages before each: ${lines.map((l) => l.loadavg.split(' ')[0]).join(' ')}`
);
const quiet = lines.map((l) => Number(/([\d.]+)/.exec(l.quiet ?? '')?.[1] ?? NaN)).filter((x) => !isNaN(x));
if (quiet.length)
	console.log(
		`quiet readings (outside busy cores): min ${Math.min(...quiet)}, median ${median(quiet)}, max ${Math.max(...quiet)}; above 0.5: ${quiet.filter((x) => x > 0.5).length} of ${quiet.length}`
	);
