import { readFileSync } from 'node:fs';

/**
 * The host side of the spawn chain, from V8 CPU profiles of the site's machine (census.ts with CPUPROF=<file>): for each
 * phase the machine runs around a clone, execve and exit_group, the samples under it as a share of busy samples.
 *   node --no-warnings --experimental-strip-types chain-phases.ts <profile> [profile ...]
 * A sample goes to the phase of the innermost frame on its stack that names one, so the rows sum to the chain's host
 * share and none is counted twice; `inclusive` counts every sample with the function anywhere on its stack. Several
 * profiles are pooled, and each is also printed alone for the spread.
 */
interface Frame {
	id: number;
	callFrame: { functionName: string; url: string };
	children?: number[];
}
interface Profile {
	nodes: Frame[];
	samples: number[];
}

// innermost first: the helpers a phase calls come before the phase
const phases: [string, string[]][] = [
	['lookup: the stub bytes, its hash, the registry, the dylink parse', ['stubHash', 'dylinkInfo', 'leb', 'lookup', 'wasm_load_executable']],
	['reset: the pristine image copied over the recycled instance', ['enterProgram']],
	['recycled hand-out: globals, relocations, tls', ['recycledProgram']],
	['program and userEnv for a start no instance recycles', ['userEnv', 'instantiateUser', 'program']],
	['retire: the instance back to its pool', ['retire']],
	['release: digests, unindex, abandon', ['dropDigests', 'unindex', 'abandon', 'release']],
	['vfork: parent and child hand-off', ['vforkStart', 'vforkTerminal', 'vforkChildStarts', 'vforkParentBack']],
	['boundStack', ['boundStack']]
];
const phaseOf = new Map<string, number>();
phases.forEach(([, names], i) => names.forEach((name) => phaseOf.set(name, i)));
const hostCalls = new Set(phases.flatMap(([, names]) => names));

const files = process.argv.slice(2);
if (!files.length) throw new Error('usage: chain-phases.ts <profile> [profile ...]');

interface Counts {
	busy: number;
	self: number[];
	leaf: number[];
	inclusive: Map<string, number>;
}
function read(file: string): Counts {
	const profile: Profile = JSON.parse(readFileSync(file, 'utf8'));
	const nodes = new Map<number, Frame>(profile.nodes.map((x) => [x.id, x]));
	const parent = new Map<number, number>();
	for (const x of nodes.values()) for (const c of x.children ?? []) parent.set(c, x.id);
	const out: Counts = {
		busy: 0,
		self: phases.map(() => 0),
		leaf: phases.map(() => 0),
		inclusive: new Map()
	};
	for (const id of profile.samples) {
		const leaf = nodes.get(id)!.callFrame.functionName;
		if (leaf === '(idle)') continue;
		out.busy++;
		const seen = new Set<string>();
		let phase = -1;
		for (let at: number | undefined = id; at !== undefined; at = parent.get(at)) {
			const name = nodes.get(at)!.callFrame.functionName;
			if (phase < 0 && phaseOf.has(name)) phase = phaseOf.get(name)!;
			if (hostCalls.has(name)) seen.add(name);
		}
		for (const name of seen) out.inclusive.set(name, (out.inclusive.get(name) ?? 0) + 1);
		if (phase >= 0) {
			out.self[phase]!++;
			// the native builtin a phase calls (a copy) shows as this frame
			if (leaf === '(program)' || leaf === '(garbage collector)') out.leaf[phase]!++;
		}
	}
	return out;
}

const runs = files.map(read);
const pooled: Counts = {
	busy: runs.reduce((n, r) => n + r.busy, 0),
	self: phases.map((_, i) => runs.reduce((n, r) => n + r.self[i]!, 0)),
	leaf: phases.map((_, i) => runs.reduce((n, r) => n + r.leaf[i]!, 0)),
	inclusive: new Map()
};
for (const r of runs) for (const [k, v] of r.inclusive) pooled.inclusive.set(k, (pooled.inclusive.get(k) ?? 0) + v);
const pct = (n: number, busy: number) => ((100 * n) / busy).toFixed(2);
const spread = (pick: (r: Counts) => number) => {
	const v = runs.map((r) => (100 * pick(r)) / r.busy);
	return `${Math.min(...v).toFixed(2)}-${Math.max(...v).toFixed(2)}`;
};

console.log(`profiles ${runs.length}, busy samples ${runs.map((r) => r.busy).join(' + ')}`);
console.log('\n| phase | share of busy, % (pooled) | per profile, min-max | of which a native copy or gc leaf, % |');
console.log('| --- | --- | --- | --- |');
phases.forEach(([label], i) =>
	console.log(
		`| ${label} | ${pct(pooled.self[i]!, pooled.busy)} | ${spread((r) => r.self[i]!)} | ${pct(pooled.leaf[i]!, pooled.busy)} |`
	)
);
const total = pooled.self.reduce((n, v) => n + v, 0);
console.log(`| all phases | ${pct(total, pooled.busy)} | ${spread((r) => r.self.reduce((n, v) => n + v, 0))} | |`);
console.log('\n| function, inclusive | share of busy, % (pooled) | per profile, min-max |');
console.log('| --- | --- | --- |');
for (const name of [...hostCalls].sort())
	console.log(
		`| ${name} | ${pct(pooled.inclusive.get(name) ?? 0, pooled.busy)} | ${spread((r) => r.inclusive.get(name) ?? 0)} |`
	);
