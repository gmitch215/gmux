import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { opNumbers } from '../../experiments/aot-oracle/scripts/functions.ts';

const op = opNumbers(readFileSync('src/gmux/katybug/kb.h', 'utf8'));
const T5 = 37;

// A (0x1000) adds and falls into B (0x2000), which adds, then ends in the given op
const dump = (end: string) =>
	[
		'arch 0',
		'block 1000 2000 0 1 5',
		`${op.ADD} 8 1 1 2 0`,
		'block 2000 2001 0 2 5',
		`${op.ADD} 8 3 3 4 0`,
		`${op[end]} 8 0 ${end === 'JMP' ? T5 : 0} 0 0`,
		''
	].join('\n');

function lift(args: string[], env: Record<string, string> = {}, end = 'JMP') {
	const dir = mkdtempSync(join(tmpdir(), 'lift-'));
	const hot = join(dir, 'd.hot');
	writeFileSync(hot, dump(end));
	const out = join(dir, 'out.c');
	const run = spawnSync(
		process.execPath,
		[
			'--no-warnings',
			'--experimental-strip-types',
			'experiments/aot-oracle/scripts/lift.ts',
			'--temps',
			'--windows',
			'--regs',
			...args,
			out,
			'1',
			`${hot}@0x1000-0x2000`,
			`${hot}@0x2000-0x2001`
		],
		{ env: { ...process.env, ...env }, encoding: 'utf8' }
	);
	expect(run.status).toBe(0);
	return { c: readFileSync(out, 'utf8'), stderr: run.stderr };
}

describe('lift --calls', () => {
	it('leaves a region at an edge into another region by default', () => {
		const { c } = lift([]);
		expect(c).not.toContain('_go(');
		expect(c).toContain('pc = 0x2000ull; goto out;');
	});

	it('runs the other region inline from that block, and hands its registers back', () => {
		const { c, stderr } = lift(['--calls']);
		expect(stderr).toContain('1 of the leaving go straight into another region');
		expect(c).toContain('struct r1_io {');
		expect(c).toContain('pc = r1p_go(cpu, 0x2000ull, &io);');
		expect(c).toContain('g3 = io.g3;');
		expect(c).toContain('goto K0_2000;');
		// the callee is emitted first, with the inline body and the entry the interpreter uses
		expect(c.indexOf('r1p_go(struct kb_cpu')).toBeLessThan(c.indexOf('r0p_run('));
		expect(c).toContain('return r1p_go(cpu, pc, NULL);');
	});

	it('calls the other region out of line under --noinline', () => {
		const inline = lift(['--calls']).c;
		const out = lift(['--calls', '--noinline']).c;
		expect(inline).toContain('static inline __attribute__((always_inline)) uint64_t r1p_go(');
		expect(out).toContain('static __attribute__((noinline)) uint64_t r1p_go(');
		expect(out).toContain('pc = r1p_go(cpu, 0x2000ull, &io);');
	});

	it('is unsound on purpose under LIFT_MUTATE=noreturn: the caller keeps its own registers', () => {
		const { c } = lift(['--calls'], { LIFT_MUTATE: 'noreturn' });
		expect(c).toContain('pc = r1p_go(cpu, 0x2000ull, &io);');
		expect(c).not.toContain('g3 = io.g3;');
	});

	it('does not call into a region that has a syscall', () => {
		expect(lift(['--calls'], {}, 'SYSCALL').c).not.toContain('_go(');
	});
});

describe('lift --ranges', () => {
	function liftRaw(args: string[], spec: (hot: string) => string) {
		const dir = mkdtempSync(join(tmpdir(), 'lift-'));
		const hot = join(dir, 'd.hot');
		writeFileSync(hot, dump('JMP'));
		return spawnSync(
			process.execPath,
			[
				'--no-warnings',
				'--experimental-strip-types',
				'experiments/aot-oracle/scripts/lift.ts',
				...args,
				join(dir, 'out.c'),
				'1',
				spec(hot)
			],
			{ encoding: 'utf8' }
		);
	}

	it('refuses an empty range instead of lifting the whole program', () => {
		for (const run of [
			liftRaw(['--ranges='], (h) => h),
			liftRaw([], (h) => `${h}@`),
			liftRaw(['--ranges=0x1000-0x2000,'], (h) => h),
			liftRaw(['--ranges=0x1000-'], (h) => h)
		]) {
			expect(run.status).not.toBe(0);
			expect(run.stderr).toContain('empty or malformed code range');
		}
	});

	it('lifts the whole dump when no range is given', () => {
		const run = liftRaw([], (h) => h);
		expect(run.status).toBe(0);
		expect(run.stderr).toContain('2 blocks, 2 lifted');
	});
});

describe('lift --only', () => {
	const only = (n: number) => lift([`--only=${n}`, '--slots', '--calls', '--noinline']).c;

	it('keeps all three tables and every form without it', () => {
		const { c } = lift(['--slots']);
		expect(c).toContain('aot_runp[]');
		expect(c).toContain('aot_runs[]');
		expect(c).toContain('aot_regs()');
	});

	it('emits one run per region, no runp or runs table, and never reads aot_regs', () => {
		for (const n of [0, 1, 2]) {
			const c = only(n);
			expect(c.match(/^static uint64_t r\d+_run\(/gm)).toHaveLength(2);
			expect(c).not.toMatch(/aot_runp|aot_runs|aot_regs|r\dp_run|r\ds_run/);
			expect(c).toContain('b->aot = aot_run[e->region];');
		}
	});

	it('calls the callee by its one name', () => {
		for (const n of [0, 1, 2]) {
			const c = only(n);
			expect(c).toContain('pc = r1_go(cpu, 0x2000ull, &io);');
			expect(c).not.toMatch(/r1[ps]_go/);
		}
	});

	it('picks the form: plain for 0, the precise body for 1, and for 2 where a region has no slot plan', () => {
		expect(only(0)).not.toContain('uint64_t gfs =');
		expect(only(1)).toContain('uint64_t gfs =');
		expect(only(2)).toContain('uint64_t gfs =');
	});

	const fails = (flags: string[]) =>
		spawnSync(
			process.execPath,
			[
				'--no-warnings',
				'--experimental-strip-types',
				'experiments/aot-oracle/scripts/lift.ts',
				...flags,
				'/dev/null',
				'1',
				'/dev/null'
			],
			{ encoding: 'utf8' }
		);

	it('errors without its prerequisite or with another value', () => {
		const base = ['--temps', '--windows'];
		expect(fails([...base, '--only=1']).stderr).toContain('--only=1 needs --regs');
		expect(fails([...base, '--regs', '--only=2']).stderr).toContain('--only=2 needs --slots');
		expect(fails([...base, '--regs', '--only=3']).stderr).toContain('--only takes 0, 1 or 2');
		expect(fails([...base, '--regs', '--only']).stderr).toContain('--only takes 0, 1 or 2');
		for (const f of [['--only=1'], ['--regs', '--only=2'], ['--regs', '--only=3']])
			expect(fails([...base, ...f]).status).not.toBe(0);
	});
});

describe('lift --bounds', () => {
	// a block that masks rcx to 0..255, scales it by 8 and loads from rdi plus that
	const indexed = [
		'arch 0',
		'block 1000 1001 0 7 5',
		`${op.MOVI} 8 32 0 0 255`,
		`${op.AND} 8 33 1 32 0`,
		`${op.MOVI} 8 34 0 0 3`,
		`${op.SHL} 8 35 33 34 0`,
		`${op.ADD} 8 36 7 35 0`,
		`${op.LD} 8 8 36 0 0`,
		`${op.JMP} 8 0 37 0 0`,
		''
	].join('\n');

	function run(args: string[], env: Record<string, string> = {}) {
		const dir = mkdtempSync(join(tmpdir(), 'lift-'));
		const hot = join(dir, 'd.hot');
		writeFileSync(hot, indexed);
		const out = join(dir, 'out.c');
		const res = spawnSync(
			process.execPath,
			[
				'--no-warnings',
				'--experimental-strip-types',
				'experiments/aot-oracle/scripts/lift.ts',
				'--temps',
				'--windows',
				...args,
				out,
				'1',
				hot
			],
			{ env: { ...process.env, ...env }, encoding: 'utf8' }
		);
		expect(res.status).toBe(0);
		return { c: readFileSync(out, 'utf8'), stderr: res.stderr };
	}

	it('leaves an indexed access checked without it', () => {
		const { c, stderr } = run([]);
		expect(stderr).toContain('0 in windows');
		expect(c).not.toContain('va0');
	});

	it('runs it in a window from the base to the end of the index range, at its own distance in', () => {
		const { c, stderr } = run(['--bounds']);
		expect(stderr).toContain(
			'1 in windows resolved once per block entry (1 with an index bound)'
		);
		// 255 elements of 8 bytes and the last one's width
		expect(c).toContain('2048u <= q->span');
		expect(c).toContain('memcpy(&v, w0 + (');
		expect(c).toContain('- va0)');
		expect(c).toContain('AOT_WINCHK(');
		// a window that does not resolve falls back for its own accesses, so the block has no checked copy
		expect(c).toContain('if (__builtin_expect(w0 != 0, 1))');
		expect(c).not.toContain('goto S0;');
	});

	it('takes no window wider than the size it is given', () => {
		const { stderr } = run(['--bounds=1024']);
		expect(stderr).toContain('0 in windows');
	});

	it('moves the end of the window under the mutants', () => {
		expect(run(['--bounds'], { LIFT_MUTATE: 'shortwindow' }).c).toContain('2040u <= q->span');
		expect(run(['--bounds'], { LIFT_MUTATE: 'longwindow' }).c).toContain('2056u <= q->span');
	});
});

function liftDump(text: string, args: string[], env: Record<string, string> = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'lift-'));
	const hot = join(dir, 'd.hot');
	writeFileSync(hot, text);
	const out = join(dir, 'out.c');
	const res = spawnSync(
		process.execPath,
		[
			'--no-warnings',
			'--experimental-strip-types',
			'experiments/aot-oracle/scripts/lift.ts',
			...args,
			out,
			'1',
			hot
		],
		{ env: { ...process.env, ...env }, encoding: 'utf8' }
	);
	return {
		status: res.status,
		c: res.status === 0 ? readFileSync(out, 'utf8') : '',
		stderr: res.stderr
	};
}

describe('lift --bounds=two', () => {
	// a 15-bit index on 2-byte entries from rdi: a window the width of a piece
	const wide = [
		'arch 0',
		'block 1000 1001 0 7 5',
		`${op.MOVI} 8 32 0 0 32767`,
		`${op.AND} 8 33 1 32 0`,
		`${op.MOVI} 8 34 0 0 1`,
		`${op.SHL} 8 35 33 34 0`,
		`${op.ADD} 8 36 7 35 0`,
		`${op.LD} 2 8 36 0 0`,
		`${op.JMP} 8 0 37 0 0`,
		''
	].join('\n');
	const base = ['--temps', '--windows'];

	it('resolves one piece for a window that is a piece wide, which fails from an unaligned base', () => {
		const { c } = liftDump(wide, [...base, '--bounds']);
		expect(c).toContain('65536u <= q->span');
		expect(c).not.toContain('aot_open2');
	});

	it('resolves the base piece and the next, and picks the piece by one compare at the access', () => {
		const { c, stderr } = liftDump(wide, [...base, '--bounds=two']);
		expect(stderr).toContain('1 in windows');
		expect(c).toContain(
			'w0 = aot_open2(cpu, &r0_win[0], &r0_win[1], gen, va, 65536u, KB_R, &x0, &bd0);'
		);
		expect(c).toContain('uint8_t* wp = AOT_PICK2(va, 2, va0, w0, x0, bd0);');
		expect(c).toContain('if (__builtin_expect(wp != 0, 1))');
		expect(c).toContain('memcpy(&v, wp, 2)');
		// a window that does not resolve leaves the access to its checked path, so there is no checked copy of the block
		expect(c).not.toContain('goto S0;');
	});

	it('leaves narrow windows as they were and keeps the default output without the flag', () => {
		const narrow = liftDump(wide, [...base, '--bounds=4080']);
		expect(narrow.stderr).toContain('0 in windows');
		const plain = liftDump(wide, [...base]);
		expect(plain.c).not.toContain('AOT_PICK2');
		expect(plain.c).not.toContain('aot_open2');
	});

	it('moves the window end under the mutants', () => {
		expect(
			liftDump(wide, [...base, '--bounds=two'], { LIFT_MUTATE: 'shortwindow' }).c
		).toContain('65534u, KB_R, &x0');
		expect(
			liftDump(wide, [...base, '--bounds=two'], { LIFT_MUTATE: 'longwindow' }).c
		).toContain('65538u, KB_R, &x0');
	});

	it('picks the pieces the wrong way round under the swappieces mutant', () => {
		const { c } = liftDump(wide, [...base, '--bounds=two'], { LIFT_MUTATE: 'swappieces' });
		expect(c).toContain('AOT_PICK2(va, 2, va0, x0, w0, bd0)');
	});

	it('refuses --identity, which has no windows', () => {
		expect(liftDump(wide, [...base, '--bounds=two', '--identity']).status).not.toBe(0);
	});

	it('opens the two pieces without a generation under --epochs, which makes the caches cold at entry', () => {
		const { c } = liftDump(wide, [...base, '--bounds=two', '--epochs']);
		expect(c).toContain('#define AOT_EPOCHS 1');
		expect(c).toMatch(/aot_open2\(cpu, &r0_win\[\d+\], &r0_win\[\d+\], 0, va, 65536u/);
		expect(c).not.toMatch(/->gen == gen|uint32_t gen|gen = /);
		expect(c).toContain('r0_cold()');
	});
});

describe('lift --loop-guards', () => {
	const RDI = 7;
	const ld = (dst: number, off: number) => `${op.LD} 8 ${dst} ${RDI} 0 ${off}`;
	// one block that loops on itself: two loads off rdi, with a syscall between them
	const self = [
		'arch 0',
		'block 1000 1001 1000 4 5',
		ld(8, 16),
		`${op.SYSCALL} 8 0 0 0 0`,
		ld(9, 24),
		`${op.BR} 8 0 0 0 0`,
		''
	].join('\n');
	// the same loop over two blocks, the second branching back to the first
	const pair = [
		'arch 0',
		'block 1000 2000 0 1 5',
		ld(8, 16),
		'block 2000 3000 1000 2 5',
		ld(9, 24),
		`${op.BR} 8 0 0 0 0`,
		''
	].join('\n');
	const flags = ['--temps', '--windows', '--regs', '--loop-guards'];

	it('needs --temps and --windows', () => {
		expect(liftDump(self, ['--loop-guards']).status).not.toBe(0);
	});

	it('resolves a window of the base register once when the loop is entered, and keeps it in locals', () => {
		const { c, stderr } = liftDump(self, flags);
		expect(stderr).toContain(
			'1 loops, 1 with windows, 1 loop windows, 2 loads and stores through them'
		);
		expect(c).toContain('uint8_t *lw0 = 0;');
		expect(c).toContain('uint64_t lva0 = 0;');
		expect(c).toContain('case 0x1000ull: if (r0_ok[0]) goto LB0; goto out;');
		expect(c).toContain('LB0: {');
		expect(c).toContain('memcpy(&v, lw0 + 0, 8)');
		expect(c).toContain('memcpy(&v, lw0 + 8, 8)');
		// the back edge stays in the loop: no new resolve
		expect(c).toContain('goto B0; pc = 0x1000ull; goto out;');
		// a window that did not resolve leaves the access checked, so it faults at its own instruction
		expect(c).toContain('if (__builtin_expect(lw0 != 0, 1))');
	});

	it('resolves the windows again after a syscall inside the loop, and not under the noreval mutant', () => {
		const good = liftDump(self, flags).c;
		const after = good.slice(
			good.indexOf('kb_syscall(cpu);'),
			good.indexOf('memcpy(&v, lw0 + 8, 8)')
		);
		expect(after).toContain('lw0 = q->gen == gen');
		expect(after).toContain('AOT_STAT(reval, 1);');
		const bad = liftDump(self, flags, { LIFT_MUTATE: 'noreval' }).c;
		expect(
			bad.slice(bad.indexOf('kb_syscall(cpu);'), bad.indexOf('memcpy(&v, lw0 + 8, 8)'))
		).not.toContain('lw0 = q->gen == gen');
		expect(bad).not.toContain('AOT_STAT(reval, 1);');
	});

	it('takes no loop window for a register the loop writes', () => {
		const moves = self
			.replace(`${op.BR} 8 0 0 0 0`, `${op.ADD} 8 ${RDI} ${RDI} 10 0\n${op.BR} 8 0 0 0 0`)
			.replace('block 1000 1001 1000 4 5', 'block 1000 1001 1000 5 5');
		const { c, stderr } = liftDump(moves, flags);
		expect(stderr).toContain('0 loop windows');
		expect(c).not.toContain('lw0');
	});

	it('takes none when the syscall writes the base register on an arch that is not x86', () => {
		const { c } = liftDump(self.replace('arch 0', 'arch 1'), flags);
		expect(c).not.toContain('lw0');
	});

	it('enters a loop of two blocks through its stubs from outside, and moves between them directly', () => {
		const { c } = liftDump(pair, flags);
		// the lifter orders blocks by weight: 0x2000 is block 0
		expect(c).toContain('case 0x2000ull: if (r0_ok[0]) goto LB0; goto out;');
		expect(c).toContain('case 0x1000ull: if (r0_ok[1]) goto LB1; goto out;');
		expect(c).toContain('LB1: {');
		expect(c).toMatch(/AOT_CONTINUE\(r0_ok\[1\], 1\)\) goto B1;/);
		expect(c).toMatch(/AOT_CONTINUE\(r0_ok\[0\], 0\)\) goto B0;/);
	});

	it('leaves a default lift without a loop stub', () => {
		const { c } = liftDump(self, ['--temps', '--windows', '--regs']);
		expect(c).not.toContain('LB0');
		expect(c).not.toContain('lw0');
	});

	it('resolves loop windows without a generation under --epochs, and the noepoch mutant never makes a cache cold', () => {
		const ok = liftDump(pair, [...flags, '--epochs']);
		expect(ok.status).toBe(0);
		expect(ok.c).toContain('lw0 = ');
		expect(ok.c).not.toMatch(/->gen == gen|uint32_t gen|gen = /);
		expect(ok.c).toContain('r0_cold()');
		const bad = liftDump(pair, [...flags, '--epochs'], { LIFT_MUTATE: 'noepoch' });
		expect(bad.c).not.toContain('r0_cold()');
	});
});

describe('lift --flags and --identity', () => {
	const ADD = 0;
	const SUB = 1;
	const ADC = 5;
	const Z = 4;

	// blocks as [pc, next, target, ops]; an op is [name, imm, a, b, c]
	type B = [number, number, number, [string, number, number?, number?, number?][]];
	function build(blocks: B[], region: string, args: string[], env: Record<string, string> = {}) {
		const dir = mkdtempSync(join(tmpdir(), 'lift-'));
		const hot = join(dir, 'd.hot');
		const text = ['arch 0'];
		for (const [pc, next, target, ops] of blocks) {
			text.push(
				`block ${pc.toString(16)} ${next.toString(16)} ${target.toString(16)} ${ops.length} 5`
			);
			for (const [name, imm, a = 0, b = 0, c = 0] of ops)
				text.push(`${op[name]} 8 ${a} ${b} ${c} ${imm}`);
		}
		writeFileSync(hot, `${text.join('\n')}\n`);
		const out = join(dir, 'out.c');
		const run = spawnSync(
			process.execPath,
			[
				'--no-warnings',
				'--experimental-strip-types',
				'experiments/aot-oracle/scripts/lift.ts',
				'--temps',
				'--windows',
				'--regs',
				'--only=0',
				...args,
				out,
				'1',
				`${hot}@${region}`
			],
			{ env: { ...process.env, ...env }, encoding: 'utf8' }
		);
		return {
			status: run.status,
			stderr: run.stderr,
			c: run.status === 0 ? readFileSync(out, 'utf8') : ''
		};
	}
	// the checked copy of a block (S<n>) repeats the fast one
	const kinds = (c: string) =>
		[...c.split(/^S0: \{/m)[0]!.matchAll(/aot_flags\(&f, (\d+),/g)].map((m) => Number(m[1]));

	// A computes flags and falls into C, which is in the dump but outside the region
	const into = (a: B[3], c: B[3]): B[] => [
		[0x1000, 0x3000, 0, a],
		[0x3000, 0x3001, 0, c]
	];
	const lifted = (blocks: B[], args: string[], env?: Record<string, string>) => {
		const r = build(blocks, '0x1000-0x2000', args, env);
		expect(r.status).toBe(0);
		return kinds(r.c);
	};

	it('drops the flag writes nothing reads by default, and --flags=all keeps every one', () => {
		const blocks = into(
			[
				['FLAGS', ADD],
				['FLAGS', SUB]
			],
			[
				['FLAGS', ADD],
				['JMP', 0]
			]
		);
		expect(lifted(blocks, [])).toEqual(lifted(blocks, ['--flags=live']));
		expect(lifted(blocks, ['--flags=all'])).toEqual([ADD, SUB]);
	});

	it('drops a write that a later write in the block covers, and keeps the one a branch reads', () => {
		const blocks = into(
			[
				['FLAGS', ADD],
				['FLAGS', SUB],
				['BR', Z]
			],
			[
				['LD', 0],
				['JMP', 0]
			]
		);
		expect(lifted(blocks, ['--flags=live'])).toEqual([SUB]);
	});

	it('keeps a write before a load, a fault point, and drops it under --identity', () => {
		const blocks = into(
			[
				['FLAGS', ADD],
				['LD', 0, 1, 2],
				['FLAGS', SUB],
				['BR', Z]
			],
			[
				['LD', 0],
				['JMP', 0]
			]
		);
		expect(lifted(blocks, ['--flags=live'])).toEqual([ADD, SUB]);
		expect(lifted(blocks, ['--flags=live', '--identity'])).toEqual([SUB]);
		expect(lifted(blocks, ['--flags=live'], { LIFT_MUTATE: 'faultdead' })).toEqual([SUB]);
	});

	it('drops the last write when the exit lands on a block that writes all five first', () => {
		const kills = into(
			[['FLAGS', SUB]],
			[
				['FLAGS', ADD],
				['JMP', 0]
			]
		);
		expect(lifted(kills, ['--flags=live'])).toEqual([]);
		const reads = into(
			[['FLAGS', SUB]],
			[
				['LD', 0],
				['FLAGS', ADD],
				['JMP', 0]
			]
		);
		expect(lifted(reads, ['--flags=live'])).toEqual([SUB]);
		const branch = into(
			[['FLAGS', SUB]],
			[
				['BR', Z],
				['FLAGS', ADD],
				['JMP', 0]
			]
		);
		expect(lifted(branch, ['--flags=live'])).toEqual([SUB]);
	});

	it('keeps the last write when the exit target is not in the dump', () => {
		const r = build([[0x1000, 0x3000, 0, [['FLAGS', SUB]]]], '0x1000-0x2000', ['--flags=live']);
		expect(kinds(r.c)).toEqual([SUB]);
	});

	it('counts a read before a write against it: a carry-in keeps the write that feeds it', () => {
		const used = into(
			[
				['FLAGS', ADD],
				['FLAGS', ADC],
				['BR', Z]
			],
			[
				['LD', 0],
				['JMP', 0]
			]
		);
		expect(lifted(used, ['--flags=live'])).toEqual([ADD, ADC]);
		const unused = into(
			[
				['FLAGS', ADD],
				['FLAGS', ADC]
			],
			[
				['FLAGS', ADD],
				['JMP', 0]
			]
		);
		expect(lifted(unused, ['--flags=live'])).toEqual([]);
	});

	it('follows flags across a block edge inside the region', () => {
		const two: B[] = [
			[0x1000, 0x2000, 0, [['FLAGS', SUB]]],
			[0x2000, 0x3000, 0, [['BR', Z]]],
			[
				0x3000,
				0x3001,
				0,
				[
					['LD', 0],
					['JMP', 0]
				]
			]
		];
		const r = build(two, '0x1000-0x3000', ['--flags=live']);
		expect(kinds(r.c)).toEqual([SUB]);
	});

	it('is unsound on purpose under LIFT_MUTATE=exitdead: an exit no longer reads the flags', () => {
		const blocks = into(
			[['FLAGS', SUB]],
			[
				['LD', 0],
				['JMP', 0]
			]
		);
		expect(lifted(blocks, ['--flags=live'], { LIFT_MUTATE: 'exitdead' })).toEqual([]);
	});

	it('--flags=none keeps only the writes a later op of the region reads', () => {
		const blocks = into(
			[
				['FLAGS', ADD],
				['LD', 0, 1, 2],
				['FLAGS', SUB],
				['BR', Z],
				['FLAGS', ADD]
			],
			[
				['LD', 0],
				['JMP', 0]
			]
		);
		expect(lifted(blocks, ['--flags=none'])).toEqual([SUB]);
	});

	it('leaves the output alone when a dump has no flag writes', () => {
		const blocks = into([['MOVI', 7, 1]], [['JMP', 0]]);
		const base = build(blocks, '0x1000-0x2000', []).c;
		expect(build(blocks, '0x1000-0x2000', ['--flags=live']).c).toBe(base);
		expect(build(blocks, '0x1000-0x2000', ['--flags=none']).c).toBe(base);
	});

	it('takes all, live or none and nothing else', () => {
		for (const f of ['--flags=maybe', '--flags']) {
			const r = build(into([['FLAGS', ADD]], [['JMP', 0]]), '0x1000-0x2000', [f]);
			expect(r.status).not.toBe(0);
			expect(r.stderr).toContain('--flags takes all, live or none');
		}
	});

	it('runs every load and store through AOT_HOST under --identity, with no window or cache call', () => {
		const blocks = into(
			[
				['LD', 0, 1, 2],
				['ST', 8, 3, 2]
			],
			[['JMP', 0]]
		);
		const plain = build(blocks, '0x1000-0x2000', []).c;
		expect(plain).not.toContain('AOT_HOST');
		expect(plain).toContain('kb_host_ic_at');
		const { c } = build(blocks, '0x1000-0x2000', ['--identity']);
		expect(c.match(/AOT_HOST\(/g)).toHaveLength(2);
		expect(c).not.toMatch(/kb_load_ic|kb_store_ic|kb_host_ic/);
	});

	it('reports each access under --classes and runs the checked ones plain under --plainchk', () => {
		// r1 is written before the access, so the access has no window and is checked one by one
		const blocks = into(
			[
				['ADD', 0, 1, 1, 2],
				['LD', 0, 3, 1],
				['ST', 0, 3, 1]
			],
			[['JMP', 0]]
		);
		const plain = build(blocks, '0x1000-0x2000', []).c;
		expect(plain).toContain('kb_load_ic');
		expect(plain).toContain('kb_store_ic');
		expect(plain).not.toMatch(/AOT_CLS|AOT_HOST/);
		const classes = build(blocks, '0x1000-0x2000', ['--classes']).c;
		expect(classes).toMatch(/AOT_CLS\(\d+, 2, 0, va, 8\);/);
		expect(classes).toMatch(/AOT_CLS\(\d+, 2, 1, va, 8\);/);
		const chk = build(blocks, '0x1000-0x2000', ['--plainchk']).c;
		expect(chk.match(/AOT_HOST\(/g)).toHaveLength(2);
		expect(chk).not.toMatch(/kb_load_ic|kb_store_ic/);
	});

	it('tests a bound checked site against its mapping first, in locals or as constants, and leaves a store site on a read-only mapping alone', () => {
		const blocks = into(
			[
				['ADD', 0, 1, 1, 2],
				['LD', 0, 3, 1],
				['ST', 0, 3, 1]
			],
			[['JMP', 0]]
		);
		const classes = build(blocks, '0x1000-0x2000', ['--classes']).c;
		const ld = Number(/AOT_CLS\((\d+), 2, 0, va, 8\);/.exec(classes)![1]);
		const st = Number(/AOT_CLS\((\d+), 2, 1, va, 8\);/.exec(classes)![1]);
		const count = join(mkdtempSync(join(tmpdir(), 'bind-')), 'c.count');
		const row = (start: string, end: string, prot: number, kind: number, st: number) =>
			`katybug cls: kind ${kind} st ${st} start ${start} end ${end} prot ${prot} bits 16 n 5000 straddle 0 cross 0`;
		const site = (id: number, st: number, map: string) =>
			`katybug site: id ${id} kind 2 st ${st} w 8 n 5000 page 0 same 0 multi 0 map ${map}`;
		writeFileSync(
			count,
			[
				row('100000', '120000', 3, 2, 0),
				row('200000', '210000', 1, 2, 1),
				site(ld, 0, '100000'),
				site(st, 1, '200000')
			].join('\n')
		);
		const locals = build(blocks, '0x1000-0x2000', [`--bind=${count}`]);
		expect(locals.stderr).toContain('--bind: 1 checked sites in 1 mappings');
		expect(locals.c).toContain('uint64_t flo0 = aot_flat[0][0], fsp0 = aot_flat[0][1];');
		expect(locals.c).toContain('va - flo0 <= fsp0 - 8');
		expect(locals.c).toContain('aot_flat[0][1] = 0x20000ull;');
		expect(locals.c).toContain('kb_load_ic');
		expect(locals.c).toContain('kb_store_ic');
		expect(locals.c).not.toMatch(/memcpy\(fh0/);
		const consts = build(blocks, '0x1000-0x2000', [`--bind=${count}`, '--bindconst']).c;
		expect(consts).toContain('va - 0x100000ull <= 0x20000ull - 8');
		expect(consts).not.toContain('aot_flat');
		const exit = build(blocks, '0x1000-0x2000', [`--bind=${count}`, '--bindexit']).c;
		expect(exit).toMatch(
			/va - flo0 <= fsp0 - 8, 1\)\) memcpy\(&v, fh0 \+ \(va - flo0\), 8\); else \{ cpu->ipc/
		);
		expect(exit).not.toContain('kb_load_ic');
		expect(exit).toContain('kb_store_ic');
		const none = build(blocks, '0x1000-0x2000', []).c;
		expect(none).not.toMatch(/flo0|aot_flat/);
		for (const f of ['--bindconst', '--bindexit']) {
			const bad = build(blocks, '0x1000-0x2000', [f]);
			expect(bad.status).not.toBe(0);
			expect(bad.stderr).toContain('need --bind=');
		}
	});

	it('finds the mappings of --flat again at run time, and binds only sites on one-block mappings with the right they need', () => {
		const blocks = into(
			[
				['ADD', 0, 1, 1, 2],
				['LD', 0, 3, 1],
				['ST', 0, 3, 1]
			],
			[['JMP', 0]]
		);
		const classes = build(blocks, '0x1000-0x2000', ['--classes']).c;
		const ld = Number(/AOT_CLS\((\d+), 2, 0, va, 8\);/.exec(classes)![1]);
		const st = Number(/AOT_CLS\((\d+), 2, 1, va, 8\);/.exec(classes)![1]);
		const dir = mkdtempSync(join(tmpdir(), 'flat-'));
		const census = (name: string, ldBits: number, stProt: number) => {
			const file = join(dir, name);
			const row = (start: string, end: string, prot: number, bits: number, st: number) =>
				`katybug cls: kind 2 st ${st} start ${start} end ${end} prot ${prot} bits ${bits} n 5000 straddle 0 cross 0`;
			const site = (id: number, st: number, map: string) =>
				`katybug site: id ${id} kind 2 st ${st} w 8 n 5000 page 0 same 0 multi 0 map ${map}`;
			writeFileSync(
				file,
				[
					row('100000', '120000', 3, ldBits, 0),
					row('300000', '310000', stProt, 63, 1),
					site(ld, 0, '100000'),
					site(st, 1, '300000')
				].join('\n')
			);
			return file;
		};
		const flat = (file: string, env: Record<string, string> = {}) =>
			build(blocks, '0x1000-0x2000', ['--epochs', `--flat=${file}`], env);
		const ok = flat(census('ok.count', 63, 3));
		expect(ok.stderr).toContain('--flat: 2 checked sites in 2 mappings');
		expect(ok.c).toContain('{{0x100000ull, KB_R}, {0x300000ull, KB_W}}');
		expect(ok.c).toContain('kb_flat_open(cpu, aot_fhint[k][0]');
		expect(ok.c).toMatch(
			/\{ AOT_STAT\(ep_slow, 1\);[^}]*\} aot_flat_sync\(cpu\); \w+_ep = ep; \}/
		);
		expect(ok.c).toContain('uint64_t flo0 = aot_flat[0].lo, fsp0 = aot_flat[0].lim;');
		expect(ok.c).toContain('va - flo0 < fsp0');
		expect(ok.c).toContain('va - flo1 < fsp1');
		expect(ok.c).toContain('aot_flat_mg != cpu->mapgen || !aot_flat_ok');
		expect(ok.c).toContain('kb_load_ic');
		expect(ok.c).toContain('kb_store_ic');
		expect(ok.c).not.toMatch(/<= fsp\d - 8/);
		expect(flat(census('pieces.count', 16, 3)).stderr).toContain(
			'--flat: 1 checked sites in 1 mappings'
		);
		expect(flat(census('wx.count', 63, 7)).stderr).toContain(
			'--flat: 1 checked sites in 1 mappings'
		);
		expect(flat(census('ro.count', 63, 1)).stderr).toContain(
			'--flat: 1 checked sites in 1 mappings'
		);
		expect(flat(census('ok.count', 63, 3), { LIFT_MUTATE: 'flatrights' }).c).toContain(
			'{{0x100000ull, KB_R}, {0x300000ull, KB_R}}'
		);
		expect(flat(census('ok.count', 63, 3), { LIFT_MUTATE: 'noflatsync' }).c).toContain(
			'__builtin_expect(aot_flat[0].lim == 0 || aot_flat[1].lim == 0 || !aot_flat_ok, 0)'
		);
		expect(flat(census('ok.count', 63, 3), { LIFT_MUTATE: 'flatlow32' }).c).toContain(
			'(uint32_t) (va - flo0) < fsp0'
		);
		const bad = build(blocks, '0x1000-0x2000', [`--flat=${census('ok.count', 63, 3)}`]);
		expect(bad.status).not.toBe(0);
		expect(bad.stderr).toContain('--flat needs --epochs');
		const both = build(blocks, '0x1000-0x2000', [
			'--epochs',
			`--flat=${census('ok.count', 63, 3)}`,
			`--bind=${census('ok.count', 63, 3)}`
		]);
		expect(both.status).not.toBe(0);
		expect(both.stderr).toContain('replaces --bind');
	});

	it('resolves a window that holds a store for writing and one that only loads for reading', () => {
		const stores = into(
			[
				['LD', 0, 1, 2],
				['ST', 8, 3, 2]
			],
			[['JMP', 0]]
		);
		const rw = build(stores, '0x1000-0x2000', []).c;
		expect(rw).toMatch(/kb_host_ic_at\(cpu, q, va, \d+u, KB_W\)/);
		expect(rw).not.toMatch(/kb_host_ic_at\([^)]*KB_R\)/);
		const loads = build(into([['LD', 0, 1, 2]], [['JMP', 0]]), '0x1000-0x2000', []).c;
		expect(loads).toMatch(/kb_host_ic_at\(cpu, q, va, \d+u, KB_R\)/);
		expect(loads).not.toContain('KB_W');
		const mutant = build(stores, '0x1000-0x2000', [], { LIFT_MUTATE: 'storeread' }).c;
		expect(mutant).not.toContain('KB_W');
	});
});

describe('lift tables', () => {
	const files = (texts: string[]) => {
		const dir = mkdtempSync(join(tmpdir(), 'lift-'));
		return {
			dir,
			paths: texts.map((t, k) => {
				const p = join(dir, `d${k}.hot`);
				writeFileSync(p, t);
				return p;
			})
		};
	};
	const run = (flags: string[], specs: string[], texts: string[]) => {
		const { dir, paths } = files(texts);
		const out = join(dir, 'out.c');
		const r = spawnSync(
			process.execPath,
			[
				'--no-warnings',
				'--experimental-strip-types',
				'experiments/aot-oracle/scripts/lift.ts',
				...flags,
				out,
				'1',
				...specs.map((s) => s.replace(/D(\d)/g, (_, k) => paths[Number(k)]!))
			],
			{ encoding: 'utf8' }
		);
		return {
			status: r.status,
			stderr: r.stderr,
			c: r.status === 0 ? readFileSync(out, 'utf8') : ''
		};
	};
	const withPcs = (pcs: string | undefined) =>
		[
			'arch 0',
			'block 1000 1006 0 2 1',
			`${op.LD} 8 1 2 0 0`,
			`${op.ADD} 8 3 3 4 0`,
			...(pcs ? [`pcs ${pcs}`] : []),
			''
		].join('\n');

	it('puts each block of a dump with instruction offsets in the table and compares them when attaching', () => {
		const { c } = run(['--temps', '--windows'], ['D0'], [withPcs('2 5')]);
		expect(c).toContain('static const uint32_t r0_p0[] = {2u, 5u};');
		expect(c).toMatch(
			/aot_table\[\] = \{\n\t\{0x1000ull?, 0x1006ull?, 0x0ull?, 2, 0, 0, r0_i0, r0_p0\}/
		);
		expect(c).toContain('memcmp(e->pcs, b->pcs, (size_t) e->n * sizeof *e->pcs)');
	});

	it('leaves a block of a dump with no offsets without a list', () => {
		const { c } = run(['--temps', '--windows'], ['D0'], [withPcs(undefined)]);
		expect(c).not.toContain('r0_p0');
		expect(c).toMatch(/r0_i0, NULL\}/);
	});

	it('takes the form of each dump from its own #form, and points aot_run at that body', () => {
		const { c } = run(
			['--temps', '--windows', '--regs', '--slots'],
			['D0#0', 'D1#1'],
			[withPcs('0 0'), withPcs('0 0')]
		);
		expect(c.match(/^static uint64_t r\d+_run\(/gm)).toHaveLength(2);
		expect(c).not.toMatch(/aot_runp|aot_runs|aot_regs|r\dp_run/);
		expect(c.split('uint64_t gfs =').length - 1).toBe(1);
	});

	it('takes the one form of every dump from --only, and refuses a form on some dumps only', () => {
		const flags = ['--temps', '--windows', '--regs'];
		expect(
			run([...flags, '--only=0'], ['D0', 'D1#1'], [withPcs('0 0'), withPcs('0 0')]).status
		).toBe(0);
		const some = run(flags, ['D0', 'D1#1'], [withPcs('0 0'), withPcs('0 0')]);
		expect(some.status).not.toBe(0);
		expect(some.stderr).toContain('needs every dump to have one');
		expect(run(flags, ['D0#3'], [withPcs('0 0')]).status).not.toBe(0);
		const noRegs = run(['--temps', '--windows'], ['D0#1'], [withPcs('0 0')]);
		expect(noRegs.status).not.toBe(0);
		expect(noRegs.stderr).toContain('--only=1 needs --regs');
	});

	it('calls only a region of its own dump, though another dump has a block at that pc', () => {
		const a = dump('JMP');
		const b = ['arch 0', 'block 2000 2001 0 1 1', `${op.ADD} 8 5 5 6 0`, ''].join('\n');
		const { c } = run(
			['--temps', '--windows', '--regs', '--calls'],
			['D1@0x2000-0x2001', 'D0@0x1000-0x2000', 'D0@0x2000-0x2001'],
			[a, b]
		);
		expect(c).toContain('pc = r2p_go(cpu, 0x2000ull, &io);');
		expect(c).not.toContain('r0p_go(cpu, 0x2000ull');
	});
});

describe('lift --lines', () => {
	it('adds only #line lines, and writes the category as the file and the guest pc as the line', () => {
		const plain = lift([]).c;
		const lines = lift(['--lines']).c;
		expect(plain).not.toContain('#line');
		expect(
			lines
				.split('\n')
				.filter((l) => !l.startsWith('#line '))
				.join('\n')
		).toBe(plain);
		expect(lines).toMatch(/#line 4096 "arith"\n\t[^\n]*= [^\n]* \+ [^\n]*;\n/);
		expect(lines).toMatch(/#line 8192 "arith"\n/);
	});

	it('puts a branch under dispatch and a flag write under flags', () => {
		const lines = lift(['--lines'], {}, 'BRZ').c;
		expect(lines).toMatch(/#line \d+ "dispatch"\n[^\n]*goto/);
	});
});
