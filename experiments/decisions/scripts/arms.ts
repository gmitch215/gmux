import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';

/**
 * Runs the arms of one decision through sim.ts one after another, REPS times each, and appends one
 * JSON line per run to experiments/decisions/results/<decision>.jsonl; arms already there are
 * skipped, so a stopped sweep resumes.
 * `node --no-warnings --experimental-strip-types experiments/decisions/scripts/arms.ts d1|d2|d3`
 */
const decision = process.argv[2];
const REPS = Number(process.env.REPS ?? 3);
const results = new URL('../results/', import.meta.url).pathname;
mkdirSync(results, { recursive: true });
const file = `${results}${decision}.jsonl`;

interface Arm {
	arm: string;
	policy: object;
	job: string;
	hours: number;
	env?: Record<string, string>;
}
const arms: Arm[] = [];

if (decision === 'd1') {
	const policies: [string, object][] = [
		['a rule', {}],
		['b 1 min', { wake: 'floor', floorMs: 60_000 }],
		['b 15 min', { wake: 'floor', floorMs: 900_000 }],
		['b 60 min', { wake: 'floor', floorMs: 3_600_000 }],
		['c 15 min', { wake: 'ontime', floorMs: 900_000 }],
		['c 1 min', { wake: 'ontime', floorMs: 60_000 }],
		['d every wake', { wake: 'always' }],
		['d every wake + quiet kept', { wake: 'always', persistQuiet: true }]
	];
	for (const [arm, policy] of policies.filter(([name]) => /^(b|c) 15 min$|^d every wake \+ quiet kept$/.test(name)))
		arms.push({ arm: `${arm} no job evict 15000`, policy, job: 'none', hours: 4, env: { EVICT_MS: '15000' } });
	for (const [arm, policy] of policies.slice(1))
		arms.push({ arm: `${arm} + save each wake evict 15000`, policy: { ...policy, saveWake: true }, job: 'silent', hours: 4, env: { EVICT_MS: '15000' } });
	for (const [arm, policy] of policies)
		for (const evict of ['15000', '1e12'])
			arms.push({ arm: `${arm} evict ${evict}`, policy, job: 'silent', hours: 4, env: { EVICT_MS: evict } });
}
if (decision === 'd2') {
	for (const turnEnd of ['first', 'budget', 'remaining', 'over'])
		for (const job of ['none', 'gzip', 'cpu'])
			arms.push({ arm: `${turnEnd} ${job} always`, policy: { turnEnd, wake: 'always' }, job, hours: 0.25 });
	for (const turnEnd of ['first', 'budget', 'remaining', 'over'])
		arms.push({ arm: `${turnEnd} gzip rule`, policy: { turnEnd }, job: 'gzip', hours: 0.25 });
}
if (decision === 'd2') {
	for (const turnEnd of ['first', 'budget', 'remaining', 'over'])
		arms.push({
			arm: `${turnEnd} cpu always rearm`,
			policy: { turnEnd, wake: 'always', rearmBusy: true },
			job: 'cpu',
			hours: 0.25
		});
}
if (decision === 'd3') {
	for (const [every, hours] of [[180_000, 3], [1_800_000, 6]] as const)
		for (const [arm, policy] of [
			['a rule', {}],
			['b rule + quiet kept', { persistQuiet: true }],
			['a every wake', { wake: 'always' }],
			['b every wake + quiet kept', { wake: 'always', persistQuiet: true }]
		] as [string, object][])
			arms.push({
				arm: `${arm} activity ${every / 60000} min`,
				policy,
				job: 'none',
				hours,
				env: { ACTIVITY_MS: String(every) }
			});
}
if (!arms.length) throw new Error('usage: arms.ts d1|d2|d3');

const done = existsSync(file)
	? readFileSync(file, 'utf8')
			.split('\n')
			.filter(Boolean)
			.map((l) => JSON.parse(l) as { arm: string; rep: number })
	: [];
for (const a of arms)
	for (let rep = 1; rep <= REPS; rep++) {
		if (done.some((d) => d.arm === a.arm && d.rep === rep)) continue;
		const started = Date.now();
		const run = spawnSync(
			'node',
			['--no-warnings', '--experimental-strip-types', new URL('./sim.ts', import.meta.url).pathname],
			{
				env: {
					...process.env,
					POLICY: JSON.stringify(a.policy),
					JOB: a.job,
					HOURS: String(a.hours),
					...a.env
				},
				encoding: 'utf8',
				maxBuffer: 1 << 26
			}
		);
		const line = run.stdout.trim().split('\n').at(-1) ?? '';
		let summary: unknown = null;
		try {
			summary = JSON.parse(line);
		} catch {
			summary = { error: (run.stderr || line).slice(-500) };
		}
		appendFileSync(
			file,
			JSON.stringify({ arm: a.arm, rep, seconds: Math.round((Date.now() - started) / 1000), summary }) + '\n'
		);
		console.log(a.arm, rep, `${Math.round((Date.now() - started) / 1000)} s`);
	}
