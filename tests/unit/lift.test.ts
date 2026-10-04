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
