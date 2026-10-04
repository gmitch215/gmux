import { readFileSync } from 'node:fs';

/**
 * Reads a V8 .cpuprofile (load.ts with PROF=<file>) and prints the share of the sampled time spent
 * in the scheduling functions, inclusive of what they call, and the top functions by self time.
 * `node --experimental-strip-types experiments/core-sched/scripts/profile.ts <file.cpuprofile> [fn...]`
 */
interface Node {
	id: number;
	callFrame: { functionName: string; url: string; lineNumber: number };
	children?: number[];
}
const [file, ...names] = process.argv.slice(2);
if (!file) {
	console.error('usage: profile.ts <file.cpuprofile> [function...]');
	process.exit(2);
}
const watch = names.length
	? names
	: ['pump', 'pickIdle', 'nextDeadline', 'park', 'now', 'resume', 'run'];
const profile = JSON.parse(readFileSync(file, 'utf8')) as {
	nodes: Node[];
	samples: number[];
	timeDeltas: number[];
};
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const parent = new Map<number, number>();
for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);

const self = new Map<number, number>();
let total = 0;
profile.samples.forEach((id, i) => {
	const dt = profile.timeDeltas[i + 1] ?? profile.timeDeltas[i]!;
	self.set(id, (self.get(id) ?? 0) + dt);
	total += dt;
});

const label = (n: Node) =>
	`${n.callFrame.functionName || '(anonymous)'} ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber + 1}`;
const bySelf = new Map<string, number>();
for (const [id, t] of self) bySelf.set(label(byId.get(id)!), (bySelf.get(label(byId.get(id)!)) ?? 0) + t);

// inclusive time of a function: each sample counted once if the function is anywhere on its stack
const inclusive = new Map<string, number>();
for (const [id, t] of self) {
	const seen = new Set<string>();
	for (let at: number | undefined = id; at !== undefined; at = parent.get(at)) {
		const name = byId.get(at)!.callFrame.functionName;
		if (watch.includes(name) && !seen.has(name)) {
			seen.add(name);
			inclusive.set(name, (inclusive.get(name) ?? 0) + t);
		}
	}
}
const pct = (t: number) => ((100 * t) / total).toFixed(2);
console.log(`sampled ${(total / 1000).toFixed(1)} ms over ${profile.samples.length} samples`);
for (const name of watch)
	console.log(`inclusive ${name.padEnd(14)} ${pct(inclusive.get(name) ?? 0).padStart(6)}%`);
console.log('top self time');
[...bySelf].sort((a, b) => b[1] - a[1]).slice(0, 18).forEach(([l, t]) =>
	console.log(`${pct(t).padStart(6)}%  ${l}`)
);
