import { readFileSync } from 'node:fs';
import { parse, type Fn } from '../../promotion-ladder/scripts/ladder.ts';

/**
 * The signature census for the bridge. Each function falls into every class its signature matches; for a set S of
 * promoted functions, a dynamic edge into a class is a down crossing when its callee is in S and its caller is not, and an
 * up crossing when its caller is in S and its callee is not (the callee's class is what the bridge must carry).
 *
 * `sigs.ts <guest.wat> <graph.json> [sets.json]` prints markdown. Without sets.json the hottest-first sets are built as
 * mixed.ts builds them: non-wide functions by dynamic instructions, as many as it takes to reach each share.
 */
type Graph = { nodes: { name: string; count: number; bytes: number }[]; edges: { from: string; to: string; count: number }[] };

const SHARES = [0.87302, 0.92312, 0.95333, 0.99873, 0.99943];
const TYPES = /^(i32|i64|f32|f64|v128|funcref|externref)$/;
const typesOf = (sig: string, kind: 'param' | 'result') =>
	[...sig.matchAll(new RegExp(`\\(${kind}([^)]*)\\)`, 'g'))].flatMap((m) => m[1]!.split(/\s+/).filter((t) => TYPES.test(t)));

const [watPath = '', graphPath = '', setsPath = ''] = process.argv.slice(2);
if (!watPath || !graphPath) throw new Error('usage: sigs.ts <guest.wat> <graph.json> [sets.json]');
const { head, tail, fns } = parse(readFileSync(watPath, 'utf8'));
const graph = JSON.parse(readFileSync(graphPath, 'utf8')) as Graph;
const total = graph.nodes.reduce((s, n) => s + n.count, 0);

const elemRefs = new Set(
	[...head, ...tail].filter((l) => /^\s*\(elem\b/.test(l)).flatMap((l) => [...l.matchAll(/\$([A-Za-z0-9_.]+)/g)].map((m) => m[1]!))
);
const sigOf = new Map<string, { params: string[]; results: string[] }>();
const classesOf = new Map<string, string[]>();
const calls = new Map<string, string[]>();
for (const fn of fns) {
	const params = typesOf(fn.header, 'param');
	const results = typesOf(fn.header, 'result');
	sigOf.set(fn.name, { params, results });
	const body = fn.body.join('\n');
	const indirect = /\bcall_indirect\b/.test(body);
	const refs = elemRefs.has(fn.name) || new RegExp(`ref\\.func \\$${fn.name.replace(/[.$]/g, '\\$&')}\\b`).test(body);
	calls.set(fn.name, [...body.matchAll(/\bcall \$([^\s)]+)/g)].map((m) => m[1]!));
	classesOf.set(fn.name, classify(params, results, indirect, refs));
}

function classify(params: string[], results: string[], indirect: boolean, refs: boolean) {
	const all = [...params, ...results];
	const out: string[] = [];
	const allI32 = all.every((t) => t === 'i32');
	if (allI32 && params.length <= 7) out.push('i32, <= 7 params');
	if (allI32 && params.length > 7) out.push('i32, > 7 params');
	if (all.includes('i64')) out.push('i64');
	if (all.some((t) => t === 'f32' || t === 'f64')) out.push('f32/f64');
	if (results.length > 1) out.push('multi-value result');
	if (all.includes('v128')) out.push('v128');
	if (indirect) out.push('call_indirect caller');
	if (refs) out.push('elem or ref.func');
	return out;
}

const wide = (name: string) => (classesOf.get(name) ?? []).some((c) => c === 'i64' || c === 'f32/f64');
const classNames = ['i32, <= 7 params', 'i32, > 7 params', 'i64', 'f32/f64', 'multi-value result', 'v128', 'call_indirect caller', 'elem or ref.func'];

const sets: Record<string, string[]> = {};
if (setsPath) Object.assign(sets, JSON.parse(readFileSync(setsPath, 'utf8')) as Record<string, string[]>);
else {
	const order = graph.nodes.filter((n) => n.count > 0 && !wide(n.name)).sort((a, b) => b.count - a.count);
	for (const share of SHARES) {
		const set: string[] = [];
		let sum = 0;
		for (const n of order) {
			if (sum / total >= share) break;
			set.push(n.name);
			sum += n.count;
		}
		if (!Object.values(sets).some((s) => s.join() === set.join())) sets[`open${Math.round(share * 1000)}`] = set;
	}
}

const unknown = new Set<string>();
for (const e of graph.edges) for (const x of [e.from, e.to]) if (!sigOf.has(x)) unknown.add(x);
if (unknown.size) throw new Error(`graph names not in the module: ${[...unknown].join(' ')}`);
const graphNames = new Set(graph.nodes.map((n) => n.name));

console.log(`## ${graphPath}\n`);
console.log(`functions in module ${fns.length}, graph nodes ${graph.nodes.length}, graph edges ${graph.edges.length}, total instructions ${total}\n`);
console.log('| class | module functions | graph functions | static call sites into | dynamic crossings into (all edges) |');
console.log('| --- | --- | --- | --- | --- |');
for (const c of classNames) {
	const inClass = (n: string) => (classesOf.get(n) ?? []).includes(c);
	const mods = fns.filter((f) => inClass(f.name)).length;
	const graphFns = graph.nodes.filter((n) => inClass(n.name)).length;
	const sites = [...calls.values()].flat().filter((n) => inClass(n)).length;
	const dyn = graph.edges.filter((e) => inClass(e.to) && e.from !== e.to).reduce((s, e) => s + e.count, 0);
	console.log(`| ${c} | ${mods} | ${graphFns} | ${sites} | ${dyn} |`);
}

for (const [label, names] of Object.entries(sets)) {
	const set = new Set(names);
	for (const n of names) if (!graphNames.has(n)) throw new Error(`${label}: ${n} is not a graph node`);
	const sum = names.reduce((s, n) => s + (graph.nodes.find((x) => x.name === n)?.count ?? 0), 0);
	console.log(`\n### ${label}: ${names.length} functions, closed share ${((100 * sum) / total).toFixed(3)}%\n`);
	console.log('| class | down crossings | up crossings |');
	console.log('| --- | --- | --- |');
	for (const c of classNames) {
		const inClass = (n: string) => (classesOf.get(n) ?? []).includes(c);
		let down = 0;
		let up = 0;
		for (const e of graph.edges) {
			if (e.from === e.to || !inClass(e.to)) continue;
			if (set.has(e.to) && !set.has(e.from)) down += e.count;
			if (set.has(e.from) && !set.has(e.to)) up += e.count;
		}
		if (down || up) console.log(`| ${c} | ${down} | ${up} |`);
	}
}
