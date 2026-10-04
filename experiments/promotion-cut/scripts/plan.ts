import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostLabel, resolveTau, sha256, type Calibration } from './calibration.ts';

/**
 * The promotion cut planner. A native set P over the dynamic call graph costs
 *
 *   J(P) = sI x (interpreted instructions left) + sN x (native instructions) + tau x crossings + lambda x code bytes
 *
 * where a crossing is a call on an edge from outside P into P (a thunk through the host), and P must be
 * closed under calls (nothing native calls back into wasm3, which is not re-entrant). Closure makes the
 * problem a project-selection cut, so the exact minimum for a given lambda is a min s-t cut; a byte
 * budget is met by the smallest lambda whose cut fits, then repaired (see mincut). The other policies build a chain of closed sets
 * and stop where J is lowest inside the budget.
 *
 * `plan.ts <graph.json> <ends.json> <out dir> <tau ns | auto | auto:<calibration.json>> <budget fraction>...`
 * writes `plan.json` (every policy and budget with its predicted cost split, and where tau came from)
 * and `sets.json` (the distinct sets, for `ladder.ts prepare`). `auto` is the calibration `tau.ts
 * calibrate` wrote when it is whole and from this host, else 270 ns.
 */
export interface Graph {
	nodes: { name: string; count: number; bytes: number; params: number; result: boolean; pinned?: boolean; wide?: boolean }[];
	edges: { from: string; to: string; count: number }[];
}

export interface Params {
	/** seconds per interpreted instruction */
	sI: number;
	/** seconds per native instruction */
	sN: number;
	/** seconds per crossing */
	tau: number;
	/** seconds per code byte */
	lambda: number;
}

export interface Split {
	interp: number;
	native: number;
	crossings: number;
	boundary: number;
	crossingBytes: number;
	bytes: number;
	/** seconds, lambda excluded */
	seconds: number;
	/** seconds with lambda */
	objective: number;
}

export type Policy = 'hottest' | 'closure' | 'scc' | 'mincut';
export const policies: Policy[] = ['hottest', 'closure', 'scc', 'mincut'];

const index = (g: Graph) => new Map(g.nodes.map((n, i) => [n.name, i]));

/** callee lists over every edge, executed or not */
export function callees(g: Graph): number[][] {
	const at = index(g);
	const out = g.nodes.map(() => new Set<number>());
	for (const e of g.edges) if (e.from !== e.to) out[at.get(e.from)!]!.add(at.get(e.to)!);
	return out.map((s) => [...s]);
}

/**
 * what a native function drags along: its callees, and for a function with an i64 or float in its
 * signature (it cannot be entered through a burrow import) its callers too
 */
export function deps(g: Graph): number[][] {
	const succ = callees(g);
	const out = succ.map((s) => new Set(s));
	succ.forEach((cs, u) => cs.forEach((v) => g.nodes[v]!.wide && out[v]!.add(u)));
	return out.map((s) => [...s]);
}

/** everything a function reaches, itself included */
export function reach(succ: number[][], roots: Iterable<number>): Set<number> {
	const seen = new Set<number>();
	const stack = [...roots];
	while (stack.length) {
		const v = stack.pop()!;
		if (seen.has(v)) continue;
		seen.add(v);
		stack.push(...succ[v]!);
	}
	return seen;
}

export function split(g: Graph, set: Set<number>, p: Params): Split {
	const at = index(g);
	let interp = 0;
	let native = 0;
	let bytes = 0;
	g.nodes.forEach((n, i) => {
		if (set.has(i)) {
			native += n.count;
			bytes += n.bytes;
		} else interp += n.count;
	});
	let crossings = 0;
	let crossingBytes = 0;
	for (const e of g.edges) {
		const to = at.get(e.to)!;
		if (set.has(to) && !set.has(at.get(e.from)!)) {
			crossings += e.count;
			crossingBytes += e.count * 4 * (g.nodes[to]!.params + 1 + (g.nodes[to]!.result ? 1 : 0));
		}
	}
	const boundary = crossings * p.tau;
	const seconds = interp * p.sI + native * p.sN + boundary;
	return { interp, native, crossings, boundary, crossingBytes, bytes, seconds, objective: seconds + bytes * p.lambda };
}

/** closed under calls, and no pinned function (one that has to stay interpreted) inside */
const closed = (g: Graph, succ: number[][], set: Set<number>) => [...set].every((v) => !g.nodes[v]!.pinned && succ[v]!.every((c) => set.has(c)));

/** chain of closed sets built by adding units in order; the best inside the budget by the model's J */
function chain(g: Graph, p: Params, budget: number, units: number[][]): Set<number> {
	const succ = deps(g);
	let set = new Set<number>();
	let best = { set, j: split(g, set, p).objective };
	for (const unit of units) {
		const next = new Set([...set, ...reach(succ, unit)]);
		if (next.size === set.size || [...next].some((v) => g.nodes[v]!.pinned)) continue;
		if (split(g, next, p).bytes > budget) continue;
		set = next;
		const j = split(g, set, p).objective;
		if (j < best.j) best = { set, j };
	}
	return best.set;
}

/** functions by own dynamic instructions, hottest first, each promoted with its callees */
function hottest(g: Graph, p: Params, budget: number) {
	const order = g.nodes.map((_, i) => i).sort((a, b) => g.nodes[b]!.count - g.nodes[a]!.count);
	return chain(g, p, budget, order.map((i) => [i]));
}

/** functions by inclusive instructions (itself plus everything it calls), caller with callees */
function closure(g: Graph, p: Params, budget: number) {
	const succ = callees(g);
	const inclusive = g.nodes.map((_, i) => [...reach(succ, [i])].reduce((s, v) => s + g.nodes[v]!.count, 0));
	const order = g.nodes.map((_, i) => i).sort((a, b) => inclusive[b]! - inclusive[a]!);
	return chain(g, p, budget, order.map((i) => [i]));
}

/** Tarjan: strongly connected components, each a list of node indexes */
export function sccs(succ: number[][]): number[][] {
	const idx = succ.map(() => -1);
	const low = succ.map(() => 0);
	const on = succ.map(() => false);
	const stack: number[] = [];
	const out: number[][] = [];
	let t = 0;
	const visit = (v: number) => {
		idx[v] = low[v] = t++;
		stack.push(v);
		on[v] = true;
		for (const w of succ[v]!) {
			if (idx[w] === -1) {
				visit(w);
				low[v] = Math.min(low[v]!, low[w]!);
			} else if (on[w]) low[v] = Math.min(low[v]!, idx[w]!);
		}
		if (low[v] === idx[v]) {
			const comp: number[] = [];
			for (;;) {
				const w = stack.pop()!;
				on[w] = false;
				comp.push(w);
				if (w === v) break;
			}
			out.push(comp);
		}
	};
	for (let v = 0; v < succ.length; v++) if (idx[v] === -1) visit(v);
	return out;
}

/** strongly connected components as units, hottest component first, each with its callees */
function scc(g: Graph, p: Params, budget: number) {
	const comps = sccs(deps(g));
	const heat = (c: number[]) => c.reduce((s, v) => s + g.nodes[v]!.count, 0);
	return chain(g, p, budget, comps.sort((a, b) => heat(b) - heat(a)));
}

/** Dinic over a dense-enough adjacency list; capacities are numbers */
function maxflow(n: number, arcs: [number, number, number][], s: number, t: number) {
	const to: number[] = [];
	const cap: number[] = [];
	const adj: number[][] = Array.from({ length: n }, () => []);
	for (const [u, v, c] of arcs) {
		adj[u]!.push(to.length);
		to.push(v);
		cap.push(c);
		adj[v]!.push(to.length);
		to.push(u);
		cap.push(0);
	}
	let flow = 0;
	for (;;) {
		const level = new Array<number>(n).fill(-1);
		level[s] = 0;
		const queue = [s];
		for (let h = 0; h < queue.length; h++)
			for (const a of adj[queue[h]!]!) if (cap[a]! > 1e-9 && level[to[a]!]! < 0) (level[to[a]!] = level[queue[h]!]! + 1), queue.push(to[a]!);
		if (level[t]! < 0) return { flow, reachable: level.map((l) => l >= 0) };
		const it = new Array<number>(n).fill(0);
		const push = (u: number, f: number): number => {
			if (u === t) return f;
			for (; it[u]! < adj[u]!.length; it[u]!++) {
				const a = adj[u]![it[u]!]!;
				if (cap[a]! > 1e-9 && level[to[a]!] === level[u]! + 1) {
					const d = push(to[a]!, Math.min(f, cap[a]!));
					if (d > 0) {
						cap[a]! -= d;
						cap[a ^ 1]! += d;
						return d;
					}
				}
			}
			return 0;
		};
		for (let f = push(s, Infinity); f > 0; f = push(s, Infinity)) flow += f;
	}
}

/** the exact minimum of J over closed sets, for the params' lambda (no budget) */
export function minCut(g: Graph, p: Params): Set<number> {
	const at = index(g);
	const n = g.nodes.length;
	const S = n;
	const T = n + 1;
	// native is the source side: a node left in T pays sI, a node in S pays sN and its bytes
	const scale = 1e12;
	const inf = Infinity;
	const arcs: [number, number, number][] = [];
	g.nodes.forEach((x, i) => {
		arcs.push([S, i, x.count * p.sI * scale]);
		arcs.push([i, T, x.pinned ? inf : (x.count * p.sN + x.bytes * p.lambda) * scale]);
	});
	for (const e of g.edges) {
		const u = at.get(e.from)!;
		const v = at.get(e.to)!;
		if (u === v) continue;
		arcs.push([v, u, e.count * p.tau * scale]);
		arcs.push([u, v, inf]);
		if (g.nodes[v]!.wide) arcs.push([v, u, inf]);
	}
	const { reachable } = maxflow(n + 2, arcs, S, T);
	return new Set(g.nodes.map((_, i) => i).filter((i) => reachable[i]));
}

/**
 * The cuts at each lambda are the lower convex hull of (bytes, J), so under a budget the smallest
 * lambda whose cut fits can miss a better set between two hull points (the constrained problem
 * contains knapsack). Two repairs are tried and the lower J kept: add the callee-closed unit that
 * lowers J most while it fits, starting from the feasible cut; drop the caller-closed unit that
 * costs least per byte freed, starting from the infeasible cut just below it.
 */
function mincut(g: Graph, p: Params, budget: number) {
	const cut = (l: number) => minCut(g, { ...p, lambda: l });
	const bytes = (set: Set<number>) => split(g, set, p).bytes;
	if (bytes(cut(p.lambda)) <= budget) return cut(p.lambda);
	let lo = p.lambda;
	let hi = Math.max(p.sI, 1e-9);
	while (bytes(cut(hi)) > budget) hi *= 2;
	for (let k = 0; k < 60; k++) {
		const mid = (lo + hi) / 2;
		if (bytes(cut(mid)) <= budget) hi = mid;
		else lo = mid;
	}
	const succ = deps(g);
	const pred = g.nodes.map(() => new Set<number>());
	succ.forEach((cs, u) => cs.forEach((v) => pred[v]!.add(u)));
	const j = (set: Set<number>) => split(g, set, p).objective;
	let grown = cut(hi);
	for (;;) {
		let best: { set: Set<number>; j: number } | undefined;
		for (let v = 0; v < g.nodes.length; v++) {
			if (grown.has(v) || g.nodes[v]!.pinned) continue;
			const next = new Set([...grown, ...reach(succ, [v])]);
			if (bytes(next) > budget) continue;
			const nj = j(next);
			if (nj < (best?.j ?? j(grown))) best = { set: next, j: nj };
		}
		if (!best) break;
		grown = best.set;
	}
	let pruned = cut(lo);
	while (bytes(pruned) > budget) {
		let best: { set: Set<number>; rate: number } | undefined;
		for (const v of pruned) {
			const callers = reach(pred, [v]);
			const next = new Set([...pruned].filter((x) => !callers.has(x)));
			const freed = bytes(pruned) - bytes(next);
			const rate = (j(next) - j(pruned)) / freed;
			if (!best || rate < best.rate) best = { set: next, rate };
		}
		pruned = best!.set;
	}
	return j(pruned) < j(grown) ? pruned : grown;
}

export function choose(policy: Policy, g: Graph, p: Params, budget: number): Set<number> {
	const set = { hottest, closure, scc, mincut }[policy](g, p, budget);
	if (!closed(g, deps(g), set)) throw new Error(`${policy} returned a set that is not closed under calls`);
	return set;
}

/** the exact optimum by enumeration, for graphs small enough (tests) */
export function bruteForce(g: Graph, p: Params, budget: number): { set: Set<number>; objective: number } {
	const succ = deps(g);
	let best = { set: new Set<number>(), objective: Infinity };
	for (let mask = 0; mask < 1 << g.nodes.length; mask++) {
		const set = new Set(g.nodes.map((_, i) => i).filter((i) => mask & (1 << i)));
		if (!closed(g, succ, set)) continue;
		const s = split(g, set, p);
		if (s.bytes <= budget && s.objective < best.objective) best = { set, objective: s.objective };
	}
	return best;
}

if (import.meta.main ?? process.argv[1]?.endsWith('plan.ts')) {
	const [graphPath, endsPath, out, tauArg, ...fractions] = process.argv.slice(2);
	if (!graphPath || !endsPath || !out || !tauArg || !fractions.length) throw new Error('usage: plan.ts <graph.json> <ends.json> <out dir> <tau ns | auto | auto:<calibration.json>> <budget fraction>...');
	const g = JSON.parse(readFileSync(graphPath, "utf8")) as Graph & { guest?: string; total: number; bytes: number; nodes: { wide?: boolean }[] };
	const [tauMode, calibrationPath] = tauArg.split(/:(.*)/s);
	const cal = calibrationPath && existsSync(calibrationPath) ? (JSON.parse(readFileSync(calibrationPath, 'utf8')) as Calibration) : undefined;
	const module = g.guest && existsSync(g.guest) ? sha256(readFileSync(g.guest)) : undefined;
	const tau = resolveTau(tauMode!, cal, hostLabel(), module);
	// ends.json is a `ladder.ts run` LADDER_JSON of the empty and the all-native rungs: ms per n units
	const ends = JSON.parse(readFileSync(endsPath, 'utf8')) as { n: number; rows: { ms: number }[] };
	const perUnit = (ms: number) => ms / 1e3 / ends.n;
	const p: Params = { sI: perUnit(ends.rows[0]!.ms) / g.total, sN: perUnit(ends.rows.at(-1)!.ms) / g.total, tau: tau.ns * 1e-9, lambda: 0 };
	const plans = fractions.flatMap((f) =>
		policies.map((policy) => {
			const budget = Number(f) * g.bytes;
			const set = choose(policy, g, p, budget);
			return { policy, budget: Number(f), set: [...set].map((i) => g.nodes[i]!.name).sort(), predicted: split(g, set, p) };
		})
	);
	mkdirSync(out, { recursive: true });
	// one rung per distinct set; a plan names the rung that ran its set (the ends are the ladder's own rungs)
	const sets: Record<string, string[]> = {};
	const rungOf = new Map<string, string>([
		["", "interpreted"],
		[g.nodes.map((n) => n.name).sort().join(","), "native"]
	]);
	const planned = plans.map((pl) => {
		const key = pl.set.join(",");
		if (!rungOf.has(key)) {
			rungOf.set(key, `${pl.policy}@${pl.budget}`);
			sets[`${pl.policy}@${pl.budget}`] = pl.set;
		}
		return { ...pl, rung: rungOf.get(key)! };
	});
	writeFileSync(join(out, "sets.json"), JSON.stringify(sets, null, "\t"));
	writeFileSync(join(out, "plan.json"), JSON.stringify({ params: { ...p, tauSource: tau.source, ...(tau.refused ? { tauRefused: tau.refused } : {}) }, total: g.total, bytes: g.bytes, plans: planned }, null, "\t"));
	for (const pl of planned)
		console.log(`${pl.policy} @${pl.budget}: ${pl.set.length} functions, ${pl.predicted.bytes} bytes, ${pl.predicted.crossings} crossings, predicted ${(pl.predicted.seconds * 1e3).toFixed(2)} ms a unit`);
}
