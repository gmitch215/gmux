import { describe, expect, it } from 'vitest';
import { encode, i32c, plan, u32 } from '../../experiments/wasm-planner/scripts/planner.ts';

const I32 = 0x7f;
const I64 = 0x7e;
const c = (n: number) => encode(i32c(n));
const [ADD, SUB, MUL, AND, OR, XOR, SHL, SHR_U, LT_S, EQ, EQZ, DIV_S] = [
	0x6a, 0x6b, 0x6c, 0x71, 0x72, 0x73, 0x74, 0x76, 0x48, 0x46, 0x45, 0x6d
];
const get = (n: number) => [0x20, n];
const set = (n: number) => [0x21, n];
const tee = (n: number) => [0x22, n];

interface Fn {
	params?: number[];
	result?: number;
	locals?: number[];
	body: number[];
	name?: string;
}

const section = (id: number, payload: number[]) => [id, ...u32(payload.length), ...payload];
const vec = (items: number[][]) => [...u32(items.length), ...items.flat()];

function build(fns: Fn[], globals: { mutable: boolean; init: number[]; exported?: string }[] = []) {
	const types = fns.map((f) => [
		0x60,
		...vec((f.params ?? [I32]).map((p) => [p])),
		...(f.result === undefined ? [1, I32] : f.result ? [1, f.result] : [0])
	]);
	const bodies = fns.map((f) => {
		const groups = (f.locals ?? []).map((t) => [...u32(1), t]);
		const body = [...vec(groups), ...f.body, 0x0b];
		return [...u32(body.length), ...body];
	});
	const exports = [
		...fns.flatMap((f, k) =>
			f.name
				? [
						[
							...u32(f.name.length),
							...[...f.name].map((ch) => ch.charCodeAt(0)),
							0,
							...u32(k)
						]
					]
				: []
		),
		...globals.flatMap((g, k) =>
			g.exported
				? [
						[
							...u32(g.exported.length),
							...[...g.exported].map((ch) => ch.charCodeAt(0)),
							3,
							...u32(k)
						]
					]
				: []
		)
	];
	return Uint8Array.from([
		0,
		0x61,
		0x73,
		0x6d,
		1,
		0,
		0,
		0,
		...section(1, vec(types)),
		...section(3, vec(fns.map((_, k) => u32(k)))),
		...(globals.length
			? section(6, vec(globals.map((g) => [I32, g.mutable ? 1 : 0, ...g.init, 0x0b])))
			: []),
		...section(7, vec(exports)),
		...section(10, vec(bodies))
	]);
}

const call = (bytes: Uint8Array<ArrayBuffer>, name: string, arg: number) => {
	try {
		const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes));
		return String((inst.exports[name] as (x: number) => number)(arg));
	} catch (e) {
		return `trap ${(e as Error).constructor.name}`;
	}
};

const ARGS = [-5, 0, 1, 7, 100, 2 ** 31 - 1];

/** plans `bytes`, checks that every export returns what it did before, and hands back the stats */
function exact(bytes: Uint8Array<ArrayBuffer>, name = 'f', only?: string[]) {
	const planned = plan(bytes, only ? new Set(only) : undefined);
	for (const x of ARGS) expect(call(planned.bytes, name, x)).toBe(call(bytes, name, x));
	return planned.stats;
}

describe('constant folding', () => {
	it('folds i32 arithmetic to one constant', () => {
		const s = exact(
			build([{ name: 'f', body: [...c(6), ...c(7), MUL, ...c(2), ADD, ...get(0), ADD] }])
		);
		expect(s.folded).toBe(2);
		expect(s.opsBefore - s.opsAfter).toBe(4);
	});

	it('folds comparisons, shifts and eqz', () => {
		const body = [
			...c(-1),
			...c(1),
			LT_S,
			...c(1),
			...c(33),
			SHL,
			ADD,
			...c(0),
			EQZ,
			ADD,
			...c(3),
			...c(3),
			EQ,
			ADD,
			...c(-8),
			...c(1),
			SHR_U,
			XOR,
			...get(0),
			AND
		];
		expect(exact(build([{ name: 'f', body }])).folded).toBe(9);
	});

	it('folds i64 and the conversions between widths', () => {
		const body = [0x42, 5, 0x42, 7, 0x7c, 0xa7, ...get(0), ADD, 0x41, 0x7f, 0xac, 0xa7, ADD];
		expect(exact(build([{ name: 'f', body }])).folded).toBe(4);
	});

	it('leaves a division that traps for the engine to trap on', () => {
		const s = exact(build([{ name: 'f', body: [...c(1), ...c(0), DIV_S, ...get(0), ADD] }]));
		expect(s.folded).toBe(0);
		expect(
			exact(build([{ name: 'f', body: [...c(-2147483648), ...c(-1), DIV_S] }])).folded
		).toBe(0);
		expect(
			exact(build([{ name: 'f', body: [...c(-7), ...c(2), DIV_S, ...get(0), ADD] }])).folded
		).toBe(1);
	});

	it('leaves a non-constant operand alone', () => {
		expect(exact(build([{ name: 'f', body: [...get(0), ...c(3), MUL] }])).folded).toBe(0);
	});
});

describe('constant propagation', () => {
	it('reads a local that was never written as zero', () => {
		const s = exact(build([{ name: 'f', locals: [I32], body: [...get(0), ...get(1), ADD] }]));
		expect(s.propagated).toBe(1);
		expect(s.localsAfter).toBe(0);
	});

	it('carries a constant from its set to its reads', () => {
		const s = exact(
			build([
				{
					name: 'f',
					locals: [I32],
					body: [...c(5), ...set(1), ...get(1), ...get(0), MUL, ...get(1), ADD]
				}
			])
		);
		expect(s.propagated).toBe(2);
		expect(s.opsAfter).toBeLessThan(s.opsBefore);
	});

	it('forgets a local after a loop can change it', () => {
		// x = 0; do { x = x + 1 } while (x < n); return x
		const body = [
			0x03,
			0x40,
			...get(1),
			...c(1),
			ADD,
			...tee(1),
			...c(50),
			LT_S,
			0x0d,
			0,
			0x0b,
			...get(1)
		];
		expect(call(plan(build([{ name: 'f', locals: [I32], body }])).bytes, 'f', 0)).toBe('50');
	});

	it('forgets a local across an if arm and its else', () => {
		const body = [
			...c(1),
			...set(1),
			...get(0),
			0x04,
			0x40,
			...c(2),
			...set(1),
			0x05,
			...get(1),
			...get(0),
			ADD,
			...set(2),
			0x0b,
			...get(1),
			...get(2),
			ADD
		];
		exact(build([{ name: 'f', locals: [I32, I32], body }]));
	});

	it('does not carry a constant past a join it does not hold at', () => {
		const body = [
			...c(4),
			...set(1),
			0x02,
			0x40,
			...get(0),
			0x0d,
			0,
			...c(9),
			...set(1),
			0x0b,
			...get(1)
		];
		exact(build([{ name: 'f', locals: [I32], body }]));
	});
});

describe('branch pruning', () => {
	const arm = (cond: number, els: boolean) => [
		...c(cond),
		0x04,
		I32,
		...c(10),
		...(els ? [0x05, ...c(20)] : [0x05, ...get(0)]),
		0x0b
	];

	it('keeps the then arm of a true if', () => {
		const s = exact(build([{ name: 'f', body: arm(1, true) }]));
		expect(s.branchesPruned).toBe(1);
		expect(s.opsAfter).toBeLessThan(s.opsBefore);
	});

	it('keeps the else arm of a false if', () => {
		expect(exact(build([{ name: 'f', body: arm(0, true) }])).branchesPruned).toBe(1);
	});

	it('empties a false if with no else', () => {
		const body = [...c(0), 0x04, 0x40, ...c(1), ...set(1), 0x0b, ...get(1)];
		expect(exact(build([{ name: 'f', locals: [I32], body }])).branchesPruned).toBe(1);
	});

	it('turns a constant br_if into a br or into nothing', () => {
		const taken = [0x02, I32, ...c(5), ...c(1), 0x0d, 0, 0x1a, ...get(0), 0x0b];
		const notTaken = [0x02, I32, ...c(5), ...c(0), 0x0d, 0, 0x1a, ...get(0), 0x0b];
		expect(exact(build([{ name: 'f', body: taken }])).branchesPruned).toBe(1);
		expect(exact(build([{ name: 'f', body: notTaken }])).branchesPruned).toBe(1);
	});

	it('picks the br_table target for a constant index and the default past the end', () => {
		const table = (idx: number) => [
			0x02,
			0x40,
			0x02,
			0x40,
			0x02,
			0x40,
			...c(idx),
			0x0e,
			2,
			0,
			1,
			2,
			0x0b,
			...c(10),
			0x0f,
			0x0b,
			...c(20),
			0x0f,
			0x0b,
			...c(30)
		];
		for (const idx of [0, 1, 2, 3, -1])
			expect(exact(build([{ name: 'f', body: table(idx) }])).branchesPruned).toBe(1);
	});
});

describe('unreachable paths', () => {
	it('drops what follows a br', () => {
		const body = [0x02, 0x40, 0x0c, 0, ...c(1), 0x1a, 0x02, 0x40, 0x0b, 0x0b, ...get(0)];
		const s = exact(build([{ name: 'f', body }]));
		expect(s.unreachableRemoved).toBe(4);
	});

	it('drops what follows a return and an unreachable, up to the else', () => {
		const body = [
			...get(0),
			0x04,
			0x40,
			...c(1),
			0x0f,
			...c(2),
			0x1a,
			0x05,
			...c(3),
			0x1a,
			0x0b,
			...get(0)
		];
		expect(exact(build([{ name: 'f', body }])).unreachableRemoved).toBe(2);
		expect(
			exact(build([{ name: 'f', body: [...get(0), 0x0f, ...c(1), ADD] }])).unreachableRemoved
		).toBe(2);
		expect(exact(build([{ name: 'f', body: [0x00, ...c(1), ADD] }])).unreachableRemoved).toBe(
			2
		);
	});

	it('replaces a function nothing reaches with an unreachable', () => {
		const bytes = build([
			{ name: 'f', body: [...get(0), 0x10, 2] },
			{ body: [...get(0), ...c(1), ADD] },
			{ body: [...get(0), ...c(2), MUL] }
		]);
		const s = exact(bytes);
		expect(s.deadFunctions).toBe(1);
	});
});

describe('dead locals', () => {
	it('turns a write nothing reads into a drop and removes the local', () => {
		const s = exact(
			build([
				{ name: 'f', locals: [I32], body: [...get(0), ...c(2), MUL, ...set(1), ...get(0)] }
			])
		);
		expect(s.deadLocalWrites).toBe(1);
		expect(s.localsAfter).toBe(0);
	});

	it('removes a tee nothing reads and both halves of a constant write', () => {
		const s = exact(
			build([
				{
					name: 'f',
					locals: [I32, I32],
					body: [...c(3), ...set(1), ...get(0), ...tee(2), ...c(1), ADD]
				}
			])
		);
		expect(s.deadLocalWrites).toBe(2);
		expect(s.localsAfter).toBe(0);
		expect(s.opsAfter).toBeLessThan(s.opsBefore - 2);
	});

	it('renumbers the locals that stay', () => {
		const body = [
			...c(1),
			...set(1),
			...get(0),
			...set(2),
			...c(4),
			...set(3),
			...get(2),
			...get(3),
			ADD
		];
		const s = exact(build([{ name: 'f', locals: [I32, I32, I32], body }]));
		expect(s.localsAfter).toBeLessThan(3);
	});
});

describe('fixed globals', () => {
	it('reads a global nothing writes as its initialiser', () => {
		const bytes = build(
			[{ name: 'f', body: [...get(0), 0x23, 0, ADD] }],
			[{ mutable: true, init: c(9) }]
		);
		expect(exact(bytes).fixedGlobalReads).toBe(1);
	});

	it('keeps a global a function writes and one the host can write', () => {
		const written = build(
			[{ name: 'f', body: [...get(0), 0x24, 0, 0x23, 0] }],
			[{ mutable: true, init: c(1) }]
		);
		expect(exact(written).fixedGlobalReads).toBe(0);
		const exported = build(
			[{ name: 'f', body: [0x23, 0] }],
			[{ mutable: true, init: c(1), exported: 'g' }]
		);
		expect(exact(exported).fixedGlobalReads).toBe(0);
	});

	it('reads an immutable global as its initialiser', () => {
		expect(
			exact(
				build(
					[{ name: 'f', body: [0x23, 0, ...get(0), MUL] }],
					[{ mutable: false, init: c(6) }]
				)
			).fixedGlobalReads
		).toBe(1);
	});
});

describe('unused blocks', () => {
	it('unwraps a block nothing branches to and retargets the branches past it', () => {
		// the inner block is never targeted; the br 1 inside it targets the outer one
		const body = [
			0x02,
			I32,
			0x02,
			0x40,
			...c(5),
			...get(0),
			0x0d,
			1,
			0x1a,
			0x0b,
			...c(3),
			0x0b
		];
		expect(exact(build([{ name: 'f', body }])).blocksUnwrapped).toBe(1);
	});

	it('unwraps a loop with no back edge and keeps one that has it', () => {
		const flat = [0x03, 0x40, ...get(0), ...set(1), 0x0b, ...get(1)];
		expect(exact(build([{ name: 'f', locals: [I32], body: flat }])).blocksUnwrapped).toBe(1);
		const back = [
			0x03,
			0x40,
			...get(1),
			...c(1),
			ADD,
			...tee(1),
			...c(9),
			LT_S,
			0x0d,
			0,
			0x0b,
			...get(1)
		];
		expect(exact(build([{ name: 'f', locals: [I32], body: back }])).blocksUnwrapped).toBe(0);
	});

	it('keeps an if', () => {
		const body = [...get(0), 0x04, 0x40, ...c(1), ...set(1), 0x0b, ...get(1)];
		expect(exact(build([{ name: 'f', locals: [I32], body }])).blocksUnwrapped).toBe(0);
	});
});

describe('the module', () => {
	it('keeps a function with an instruction it does not decode', () => {
		const bytes = build([
			{ name: 'f', params: [0x7d], result: I32, body: [...get(0), 0xfc, 0x00] }
		]);
		const { stats, bytes: out } = plan(bytes);
		expect(stats.skipped).toBe(1);
		expect(() => new WebAssembly.Module(out)).not.toThrow();
	});

	it('runs no pass when told to run none', () => {
		const bytes = build([
			{ name: 'f', locals: [I32], body: [...c(2), ...c(3), ADD, ...set(1), ...get(1)] }
		]);
		const s = exact(bytes, 'f', []);
		expect(s.opsAfter).toBe(s.opsBefore);
	});

	it('rejects bytes that are not wasm', () => {
		expect(() => plan(Uint8Array.from([1, 2, 3]))).toThrow('not wasm');
	});

	it('reports i64 locals and multiple functions', () => {
		const body = [0x42, 3, ...[0x21, 1], ...[0x20, 1], 0xa7, ...get(0), ADD];
		const s = exact(build([{ name: 'f', locals: [I64], body }]));
		expect(s.functions).toBe(1);
	});
});

// #region differential
function random(seed: number) {
	let a = seed >>> 0;
	return (n: number) => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return (((t ^ (t >>> 14)) >>> 0) % n) | 0;
	};
}

function program(seed: number) {
	const rnd = random(seed);
	const ops = [ADD, SUB, MUL, AND, OR, XOR, SHL, SHR_U, LT_S, EQ];
	const expr = (d: number): number[] => {
		const k = rnd(d > 2 ? 4 : 7);
		if (k === 0) return c([0, 1, -1, 2, 7, 100][rnd(6)]!);
		if (k === 1) return get(rnd(4));
		if (k === 2) return [0x23, rnd(2)];
		if (k === 3) return [...get(rnd(4)), ...c(rnd(9)), ADD];
		if (k === 4) return [...expr(d + 1), EQZ];
		if (k === 5) return [...expr(d + 1), ...expr(d + 1), ops[rnd(ops.length)]!];
		return [...expr(d + 1), 0x04, I32, ...expr(d + 1), 0x05, ...expr(d + 1), 0x0b];
	};
	// local 3 is the loop counter: only code outside the loop writes it, and nothing branches back to the loop
	const stmts = (labels: number, depth: number, loopAt: number): number[] => {
		const out: number[] = [];
		const inLoop = loopAt >= 0;
		const target = () => {
			const d = rnd(labels);
			return inLoop && d === labels - 1 - loopAt ? -1 : d;
		};
		for (let n = rnd(4); n >= 0; n--) {
			const k = rnd(depth > 2 ? 4 : 9);
			const d = labels > 0 ? target() : -1;
			const dest = inLoop ? 1 + rnd(2) : 1 + rnd(3);
			const inner = () => stmts(labels + 1, depth + 1, loopAt);
			if (k <= 1) out.push(...expr(1), ...set(dest));
			else if (k === 2 && d >= 0) out.push(...expr(1), 0x0d, d);
			else if (k === 3 && d >= 0) out.push(...c(rnd(2)), 0x0d, d);
			else if (k === 4)
				out.push(
					...expr(1),
					0x04,
					0x40,
					...inner(),
					...(rnd(2) ? [0x05, ...inner()] : []),
					0x0b
				);
			else if (k === 5)
				out.push(...c(rnd(2)), 0x04, 0x40, ...inner(), 0x05, ...inner(), 0x0b);
			else if (k === 6) out.push(0x02, 0x40, ...inner(), 0x0b);
			else if (k === 7 && !inLoop)
				out.push(
					...c(1 + rnd(4)),
					...set(3),
					0x03,
					0x40,
					...stmts(labels + 1, depth + 1, labels),
					...get(3),
					...c(1),
					SUB,
					...tee(3),
					0x0d,
					0,
					0x0b
				);
			else if (k === 8 && d >= 0) out.push(0x0c, d, ...expr(1), 0x1a);
			else out.push(...expr(1), 0x1a);
		}
		return out;
	};
	const body = [...stmts(0, 0, -1), ...get(1), ...get(2), ADD, ...get(3), XOR, ...get(0), ADD];
	return build(
		[{ name: 'f', locals: [I32, I32, I32], body }],
		[
			{ mutable: false, init: c(7) },
			{ mutable: true, init: c(3) }
		]
	);
}

describe('planned against unplanned', () => {
	it('returns the same value on 400 random programs', () => {
		let rewrites = 0;
		for (let seed = 1; seed <= 400; seed++) {
			const bytes = program(seed);
			const s = exact(bytes);
			rewrites +=
				s.folded +
				s.propagated +
				s.branchesPruned +
				s.unreachableRemoved +
				s.deadLocalWrites +
				s.blocksUnwrapped +
				s.fixedGlobalReads;
		}
		expect(rewrites).toBeGreaterThan(400);
	});

	it('returns the same value with each pass alone', () => {
		for (const pass of ['unreachable', 'prune', 'propagate', 'drops', 'deadlocals', 'unwrap'])
			for (let seed = 1; seed <= 60; seed++) exact(program(seed), 'f', [pass]);
	});
});
// #endregion
