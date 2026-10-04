import { describe, expect, it } from 'vitest';
import {
	dirhPoints,
	dirSavings,
	lookupNs,
	slopes,
	wsAt,
	wsPoints,
	type WsPoint
} from '../../experiments/cut-model/scripts/lookup.ts';
import type { Row } from '../../experiments/cut-model/scripts/model.ts';
import {
	ownLookupNs,
	predictArch,
	withCounters
} from '../../experiments/cut-model/scripts/predict-model.ts';
import { gen } from '../../experiments/cut-model/scripts/ws-gen.ts';

const row = (workload: string, arm: string, blocks: number, wall: number): Row => ({
	arch: 'x86_64',
	workload,
	arm,
	blocks,
	exits: 0,
	ops: 0,
	lookups: blocks,
	held: 0,
	seconds: wall,
	wall,
	spread: 0
});

/** a short and a long run of a guest, at ns a dispatch after a fixed decoding cost */
const guest = (name: string, arm: string, ns: number, fixed = 0.5): Row[] => [
	row(`${name}-7`, arm, 7_000_000, fixed + (7e6 * ns) / 1e9),
	row(`${name}-31`, arm, 31_000_000, fixed + (31e6 * ns) / 1e9)
];

const points: WsPoint[] = [
	{ B: 16, H: 16, ns: 10 },
	{ B: 1024, H: 16, ns: 10 },
	{ B: 1024, H: 1024, ns: 12 },
	{ B: 98_000, H: 16, ns: 14 },
	{ B: 98_000, H: 1024, ns: 30 },
	{ B: 98_000, H: 98_000, ns: 270 }
];

describe('working-set slopes', () => {
	it('leaves out the fixed decoding cost', () => {
		const m = slopes(
			[...guest('ind-98000-16', 'base', 14, 3), ...guest('ind-16-16', 'base', 10, 0)],
			'base'
		);
		expect(m.get('ind-98000-16')).toBeCloseTo(14, 6);
		expect(m.get('ind-16-16')).toBeCloseTo(10, 6);
	});

	it('reads only the ind guests as points, with B and H from the name', () => {
		const p = wsPoints([
			...guest('ind-98000-1024', 'base', 30),
			...guest('dir-98000-98000', 'base', 270)
		]);
		expect(p).toHaveLength(1);
		expect(p[0]).toMatchObject({ B: 98_000, H: 1024 });
		expect(p[0]!.ns).toBeCloseTo(30, 6);
	});

	it('prices a lookup a chaining build avoids as base minus chain, by B', () => {
		const rows = [
			...guest('dir-20000-20000', 'base', 100),
			...guest('dir-20000-20000', 'chain', 12),
			...guest('dir-16-16', 'base', 12.2),
			...guest('dir-16-16', 'chain', 12)
		];
		const s = dirSavings(rows);
		expect(s.map((x) => x.B)).toEqual([16, 20000]);
		expect(s[0]!.ns).toBeCloseTo(0.2, 6);
		expect(s[1]!.ns).toBeCloseTo(88, 6);
	});

	it('reads what chaining saves at (B, H) off the dirh guests only', () => {
		const rows = [
			...guest('dirh-4096-256', 'base', 20),
			...guest('dirh-4096-256', 'chain', 12),
			...guest('dirh-16-16', 'base', 12.3),
			...guest('dirh-16-16', 'chain', 12),
			...guest('dir-20000-20000', 'base', 100),
			...guest('dir-20000-20000', 'chain', 12)
		];
		const p = dirhPoints(rows);
		expect(p.map((x) => [x.B, x.H])).toEqual([
			[16, 16],
			[4096, 256]
		]);
		expect(p[1]!.ns).toBeCloseTo(8, 6);
		expect(lookupNs({ lookup0: p[0]!.ns, points: p }, 4096, 256)).toBeCloseTo(8, 6);
	});
});

describe('working-set guest', () => {
	it('dirh decodes all B blocks, then cycles over H of them with direct jumps only', () => {
		for (const arch of ['x86_64', 'aarch64']) {
			const s = gen(arch, 'dirh', 64, 8, 10);
			expect(s).not.toContain('tbl');
			expect(s.match(/^blk\d+:/gm)).toHaveLength(64);
			expect(
				s.match(arch === 'x86_64' ? /\tjnz blk\d+/g : /\tcbnz x14, blk\d+/g)
			).toHaveLength(64);
		}
	});
});

describe('lookup against the working set', () => {
	it('returns the measured value at a measured point', () => {
		for (const p of points) expect(wsAt(points, p.B, p.H)).toBeCloseTo(p.ns, 9);
	});

	it('interpolates along H inside a family, in log2', () => {
		// 98000 blocks held: 16 -> 14 ns, 1024 -> 30 ns, so 128 (3 of 6 doublings) is halfway
		expect(wsAt(points, 98_000, 128)).toBeCloseTo(
			14 + (30 - 14) * (Math.log2(128 / 16) / Math.log2(1024 / 16)),
			9
		);
	});

	it('interpolates between held-block families and holds the ends', () => {
		const mid = Math.sqrt(1024 * 98_000);
		expect(wsAt(points, mid, 16)).toBeCloseTo(12, 9);
		expect(wsAt(points, 4, 4)).toBe(10);
		expect(wsAt(points, 1_000_000, 98_000)).toBe(270);
	});

	it('caps H at B', () => {
		expect(wsAt(points, 1024, 50_000)).toBe(12);
	});

	it('adds only what the working set costs over the 16 x 16 guest to the small-guest lookup', () => {
		const t = { lookup0: 0.5, points };
		expect(lookupNs(t, 16, 16)).toBeCloseTo(0.5, 9);
		expect(lookupNs(t, 98_000, 1024)).toBeCloseTo(0.5 + 20, 9);
	});

	it('refuses a table without the small guest', () => {
		expect(() => lookupNs({ lookup0: 0, points: points.slice(1) }, 100, 10)).toThrow(/16 x 16/);
	});
});

describe('prediction from a frozen table', () => {
	const side = { ns: 0, se: 0, min: 0, max: 0, n: 1 };
	const arms = ['base', 'chain', 'fuse', 't2', 't4', 't8', 't16', 't32', 't64'];
	const table = (lookup: object) => ({
		fixedMs: Object.fromEntries(arms.map((a) => [a, 10])),
		blockNs: {
			chain: { ...side, ns: 9 },
			fuse: { ...side, ns: 9 },
			trace: { ...side, ns: 12 }
		},
		exitNsByArm: Object.fromEntries(arms.map((a) => [a, { ...side, ns: 4 }])),
		...lookup
	});
	const r = (arm: string, o: Partial<Row>): Row => ({
		...row('w', arm, 100e6, 0),
		ops: 1000e6,
		lookups: 100e6,
		held: 90_000,
		...o
	});
	// base: 10 + 2 ns * 1000M ops + 9 ns * 100M blocks + 3 ns * 100M lookups = 3210 ms
	const rows = [
		r('base', { wall: 3.21 }),
		r('chain', { lookups: 10e6, wall: 2.94 }),
		r('t8', { blocks: 40e6, exits: 1e6, lookups: 10e6, wall: 2.6 })
	];
	const flat = table({ lookupNs: { ...side, ns: 3 } });

	it('solves the per-op cost from the base arm and prices every other arm from the table', () => {
		const cells = predictArch(
			flat,
			rows,
			() => 0,
			() => undefined,
			0
		);
		const chain = cells.find((c) => c.arm === 'chain')!;
		expect(chain.predicted).toBeCloseTo(10 + 2000 + 900 + 30, 6);
		expect(chain.error).toBeCloseTo(0, 6);
		const t8 = cells.find((c) => c.arm === 't8')!;
		expect(t8.predicted).toBeCloseTo(10 + 2000 + 12 * 40 + 3 * 10 + 4 * 1, 6);
	});

	it('charges an op more in a long block when the block model has q', () => {
		const byArm = Object.fromEntries(
			arms.map((a) => [a, { block: 9, q: a === 't8' ? 0.01 : 0 }])
		);
		const t = { ...flat, blockModel: { byArm } };
		const cells = predictArch(
			t,
			rows,
			() => 0,
			() => undefined,
			0
		);
		const t8 = cells.find((c) => c.arm === 't8')!;
		// 25 ops a t8 block (1000M ops over 40M blocks) at 0.01 ns a op of length
		expect(t8.predicted).toBeCloseTo(10 + 2000 + 0.01 * 25 * 1000 + 9 * 40 + 3 * 10 + 4 * 1, 6);
	});

	it("scales the base arm's per-op cost by the arm's op term from the block model", () => {
		const byArm = Object.fromEntries(
			arms.map((a) => [a, { block: 9, q: 0, opScale: a === 't8' ? 1.05 : 1 }])
		);
		const t = { ...flat, blockModel: { byArm } };
		const cells = predictArch(
			t,
			rows,
			() => 0,
			() => undefined,
			0
		);
		const t8 = cells.find((c) => c.arm === 't8')!;
		expect(t8.predicted).toBeCloseTo(10 + 2000 * 1.05 + 9 * 40 + 3 * 10 + 4 * 1, 6);
	});

	it('prices a program at its own lookup cost when one is given', () => {
		const cells = predictArch(
			flat,
			rows,
			() => 0,
			() => undefined,
			0,
			() => 5
		);
		// the op term is solved again with the lookups at 5 ns, then the chain arm's 10M lookups priced at 5
		const op = (3210 - 10 - 900 - 500) / 1000;
		expect(cells.find((c) => c.arm === 'chain')!.predicted).toBeCloseTo(
			10 + op * 1000 + 900 + 50,
			6
		);
	});

	it('prices a lookup at the working set when the table has the term', () => {
		const t = table({
			lookupWs: {
				lookup0: 0,
				points: [
					{ B: 16, H: 16, ns: 10 },
					{ B: 98_000, H: 16, ns: 10 },
					{ B: 98_000, H: 98_000, ns: 270 }
				]
			}
		});
		const small = predictArch(
			t,
			rows,
			() => 0,
			() => ({ held: 98_000, spread: 16 }),
			0
		).find((c) => c.arm === 'chain')!;
		const big = predictArch(
			t,
			rows,
			() => 0,
			() => ({ held: 98_000, spread: 98_000 }),
			0
		).find((c) => c.arm === 'chain')!;
		expect(small.lookupNs).toBeCloseTo(0, 6);
		expect(big.lookupNs).toBeGreaterThan(200);
		expect(() =>
			predictArch(
				t,
				rows,
				() => 0,
				() => undefined,
				0
			)
		).toThrow(/no hot-set row/);
	});

	it('takes counters from a run that kept them and keeps its own timings', () => {
		const lost = [{ ...r('chain', { wall: 2.5 }), blocks: 0, ops: 0, lookups: 0, held: 0 }];
		const merged = withCounters(lost, [
			r('chain', { wall: 9, blocks: 77, ops: 5, lookups: 3, held: 11 })
		]);
		expect(merged[0]).toMatchObject({ blocks: 77, ops: 5, lookups: 3, held: 11, wall: 2.5 });
	});

	it("reads a program's own ns a lookup from the time chaining saves over the lookups it avoids", () => {
		const rows = [
			{ ...row('p', 'base', 1000, 2), lookups: 1000 },
			{ ...row('p', 'chain', 1000, 1.5), lookups: 200 },
			{ ...row('q', 'base', 10, 1), lookups: 10 }
		];
		const own = ownLookupNs(rows);
		expect(own.get('p')).toBeCloseTo(0.5e9 / 800, 6);
		expect(own.has('q')).toBe(false);
	});
});
