import { describe, expect, it } from 'vitest';
import {
	bruteForce,
	callees,
	choose,
	minCut,
	policies,
	reach,
	sccs,
	split,
	type Graph,
	type Params
} from '../../experiments/promotion-cut/scripts/plan.ts';

const node = (name: string, count: number, bytes = 100) => ({
	name,
	count,
	bytes,
	params: 1,
	result: true
});

// main calls A twice, A calls B 500 times and C 20 times; B is the hottest function
const hand: Graph = {
	nodes: [node('main', 10), node('A', 1000), node('B', 1500), node('C', 20)],
	edges: [
		{ from: 'main', to: 'A', count: 2 },
		{ from: 'A', to: 'B', count: 500 },
		{ from: 'A', to: 'C', count: 20 }
	]
};
const p: Params = { sI: 1, sN: 0.1, tau: 10, lambda: 0 };
const names = (g: Graph, set: Set<number>) => [...set].map((i) => g.nodes[i]!.name).sort();

describe('promotion cut planner', () => {
	it('prices the hand-built graph as worked out on paper', () => {
		const at = (...n: string[]) =>
			new Set(n.map((x) => hand.nodes.findIndex((y) => y.name === x)));
		expect(split(hand, at(), p).seconds).toBe(2530);
		// B alone: 1500 x 0.1 native, 1020 left, A calls it 500 times
		expect(split(hand, at('B'), p)).toMatchObject({ crossings: 500, bytes: 100 });
		expect(split(hand, at('B'), p).seconds).toBeCloseTo(1030 + 150 + 5000);
		// A with its callees: main's two calls cross, everything else is native
		const abc = split(hand, at('A', 'B', 'C'), p);
		expect(abc.crossings).toBe(2);
		expect(abc.seconds).toBeCloseTo(10 + 252 + 20);
		expect(abc.crossingBytes).toBe(2 * 4 * 3);
		expect(split(hand, at('main', 'A', 'B', 'C'), p).seconds).toBeCloseTo(253);
	});

	it('finds the best cut for each byte budget', () => {
		// 200 bytes: no closed set pays for its crossings, so nothing is promoted; 300: A with B and C; 400: all
		expect(names(hand, minCut(hand, p))).toEqual(['A', 'B', 'C', 'main']);
		for (const [budget, want] of [
			[200, []],
			[300, ['A', 'B', 'C']],
			[400, ['A', 'B', 'C', 'main']]
		] as const) {
			const best = bruteForce(hand, p, budget);
			expect(names(hand, best.set)).toEqual(want);
			expect(names(hand, choose('mincut', hand, p, budget))).toEqual(want);
			for (const policy of policies)
				expect(
					split(hand, choose(policy, hand, p, budget), p).objective
				).toBeGreaterThanOrEqual(best.objective - 1e-9);
		}
	});

	it('promotes the callees a function needs, and no policy returns an open set', () => {
		const succ = callees(hand);
		for (const policy of policies)
			for (const budget of [0, 100, 200, 300, 400]) {
				const set = choose(policy, hand, p, budget);
				expect([...set].every((v) => succ[v]!.every((c) => set.has(c)))).toBe(true);
				expect(split(hand, set, p).bytes).toBeLessThanOrEqual(budget);
			}
		expect(names(hand, reach(succ, [1]))).toEqual(['A', 'B', 'C']);
	});

	it('groups mutual callers into one component', () => {
		const g: Graph = {
			nodes: [node('a', 1), node('b', 1), node('c', 1)],
			edges: [
				{ from: 'a', to: 'b', count: 1 },
				{ from: 'b', to: 'a', count: 1 },
				{ from: 'b', to: 'c', count: 1 }
			]
		};
		const comps = sccs(callees(g)).map((c) => [...c].sort());
		expect(comps).toContainEqual([0, 1]);
		expect(comps).toContainEqual([2]);
	});

	it('matches enumeration on random graphs with no budget', () => {
		let seed = 12345;
		const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
		for (let k = 0; k < 200; k++) {
			const n = 3 + Math.floor(next() * 5);
			const g: Graph = {
				nodes: Array.from({ length: n }, (_, i) =>
					node(`f${i}`, Math.floor(next() * 1000), 50 + Math.floor(next() * 100))
				),
				edges: []
			};
			for (let e = 0; e < n * 2; e++) {
				const from = Math.floor(next() * n);
				const to = Math.floor(next() * n);
				if (from !== to)
					g.edges.push({
						from: `f${from}`,
						to: `f${to}`,
						count: Math.floor(next() * 300)
					});
			}
			const q: Params = {
				sI: 1,
				sN: 0.05 + next() * 0.5,
				tau: next() * 8,
				lambda: next() * 0.5
			};
			const best = bruteForce(g, q, Infinity);
			expect(split(g, minCut(g, q), q).objective).toBeCloseTo(best.objective, 6);
		}
	});

	it('keeps every policy inside a byte budget on random graphs, and never worse than promoting nothing', () => {
		let seed = 777;
		const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
		for (let k = 0; k < 100; k++) {
			const n = 4 + Math.floor(next() * 4);
			const g: Graph = {
				nodes: Array.from({ length: n }, (_, i) =>
					node(`f${i}`, Math.floor(next() * 1000), 50 + Math.floor(next() * 100))
				),
				edges: []
			};
			for (let e = 0; e < n * 2; e++) {
				const from = Math.floor(next() * n);
				const to = Math.floor(next() * n);
				if (from !== to)
					g.edges.push({
						from: `f${from}`,
						to: `f${to}`,
						count: Math.floor(next() * 300)
					});
			}
			const q: Params = { sI: 1, sN: 0.1, tau: next() * 5, lambda: 0 };
			const budget = Math.floor(next() * 500);
			const optimum = bruteForce(g, q, budget).objective;
			for (const policy of policies) {
				const s = split(g, choose(policy, g, q, budget), q);
				expect(s.bytes).toBeLessThanOrEqual(budget);
				expect(s.objective).toBeLessThanOrEqual(split(g, new Set(), q).objective + 1e-9);
				expect(s.objective).toBeGreaterThanOrEqual(optimum - 1e-9);
			}
		}
	});
});
