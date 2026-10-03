import { readFileSync } from 'node:fs';

/**
 * Tables from epochs.sh's sums: one line per workload and arm, `<workload> <arm> key=value ...`, every
 * counter summed over the processes of the run.
 */
const [file = ''] = process.argv.slice(2);
type Sums = Record<string, number>;
const runs = new Map<string, Sums>();
for (const line of readFileSync(file, 'utf8').trim().split('\n')) {
	const [workload, arm, ...pairs] = line.split(' ');
	const sums: Sums = {};
	for (const pair of pairs) {
		const [key = '', value = '0'] = pair.split('=');
		sums[key] = Number(value);
	}
	runs.set(`${workload} ${arm}`, sums);
}
const workloads = [...new Set([...runs.keys()].map((k) => k.split(' ')[0] ?? ''))];
const get = (workload: string, arm: string): Sums => runs.get(`${workload} ${arm}`) ?? {};
const per1000 = (s: Sums, key: string) => ((s[key] ?? 0) * 1000) / (s.insns ?? 1);
const perMillion = (s: Sums, key: string) => ((s[key] ?? 0) * 1e6) / (s.blocks ?? 1);
const f = (n: number, digits = 2) => n.toFixed(digits);

console.log('Checks per 1,000 guest instructions, without the epoch guard (before) and with it (after).');
console.log('');
console.log('| workload | arm | guest instructions | mapping generation compares | code generation compares | signal poll tests | signal polls made | epoch compares | assumption checks | range compares |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const w of workloads)
	for (const arm of ['before', 'after']) {
		const s = get(w, arm);
		const assumed = per1000(s, 'ck_gen') + per1000(s, 'ck_code') + per1000(s, 'ck_poll') + per1000(s, 'ck_epoch');
		console.log(
			`| ${w} | ${arm} | ${s.insns} | ${f(per1000(s, 'ck_gen'))} | ${f(per1000(s, 'ck_code'))} | ${f(per1000(s, 'ck_poll'))} | ${f(per1000(s, 'polls'))} | ${f(per1000(s, 'ck_epoch'))} | ${f(assumed)} | ${f(per1000(s, 'ck_range'))} |`
		);
	}

console.log('');
console.log('Every check the interpreter makes, before the guard, per 1,000 guest instructions (an assumption check can become an epoch; the rest read a result or an operand).');
console.log('');
const guards: [string, string, string][] = [
	['ck_range', 'load or store range compare', 'operand (load-bearing)'],
	['ck_gen', 'load or store mapping generation compare', 'assumption'],
	['ck_fault', 'fault test after a load, store or helper', 'result'],
	['ck_link', 'block link selection (target or next)', 'operand'],
	['ck_exit', 'exit test in the run loop', 'result'],
	['exits', 'trace side exit condition', 'operand'],
	['ck_code', 'code generation compare on a block link', 'assumption'],
	['ck_poll', 'signal poll test (back edge or syscall)', 'assumption'],
	['ck_thread', 'thread slice test', 'assumption']
];
console.log(`| guard | kind | ${workloads.join(' | ')} |`);
console.log(`| --- | --- | ${workloads.map(() => '---').join(' | ')} |`);
for (const [key, what, kind] of guards.sort((a, b) => workloads.reduce((n, w) => n + per1000(get(w, 'before'), b[0]), 0) - workloads.reduce((n, w) => n + per1000(get(w, 'before'), a[0]), 0)))
	console.log(`| ${what} | ${kind} | ${workloads.map((w) => f(per1000(get(w, 'before'), key))).join(' | ')} |`);

console.log('');
console.log('Epoch events with the guard, per million block runs.');
console.log('');
console.log('| workload | block runs | mapping bumps | signal bumps | slow paths (signal polls) | mapping deopts | code deopts |');
console.log('| --- | --- | --- | --- | --- | --- | --- |');
for (const w of workloads) {
	const s = get(w, 'after');
	console.log(
		`| ${w} | ${s.blocks} | ${f(perMillion(s, 'bump_map'))} | ${f(perMillion(s, 'bump_sig'))} | ${f(perMillion(s, 'polls'))} | ${f(perMillion(s, 'deopt_map'))} | ${f(perMillion(s, 'deopt_code'))} |`
	);
}

console.log('');
console.log('What the other epochs would cover, per 1,000 guest instructions (the guarded-state reads each has today).');
console.log('');
console.log('| workload | fs base reads | cpuid | indirect jumps | block lookups | trace side exit conditions | syscalls | credential syscalls | descriptor syscalls | socket syscalls |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const w of workloads) {
	const s = get(w, 'after');
	console.log(
		`| ${w} | ${f(per1000(s, 'rd_fs'))} | ${f(per1000(s, 'rd_cpuid'))} | ${f(per1000(s, 'ijmp'))} | ${f(per1000(s, 'lookups'))} | ${f(per1000(s, 'exits'))} | ${f(per1000(s, 'sys'), 3)} | ${f(per1000(s, 'cred'), 3)} | ${f(per1000(s, 'fd'), 3)} | ${f(per1000(s, 'sock'), 3)} |`
	);
}
