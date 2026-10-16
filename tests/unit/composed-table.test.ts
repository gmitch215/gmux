import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// a module whose one function, index 0, is exported as wasm_syscall_0
const KERNEL = Uint8Array.from([
	0,
	0x61,
	0x73,
	0x6d,
	1,
	0,
	0,
	0,
	1,
	4,
	1,
	0x60,
	0,
	0,
	3,
	2,
	1,
	0,
	7,
	0x12,
	1,
	14,
	...Buffer.from('wasm_syscall_0'),
	0,
	0,
	10,
	4,
	1,
	2,
	0,
	0x0b
]);

const frame = (id: number, functionName: string, url = '', children: number[] = []) => ({
	id,
	callFrame: { functionName, url, lineNumber: 0 },
	children
});

describe('composed table', () => {
	it('puts every busy sample in one row and tells kernel entries, kernel leaves, guest, ingress and gc apart', () => {
		const dir = mkdtempSync(join(tmpdir(), 'composed-'));
		const build = join(dir, 'build');
		mkdirSync(join(build, 'kernel'), { recursive: true });
		writeFileSync(join(build, 'kernel/vmlinux.async.wasm'), KERNEL);
		const kernel = 'wasm://wasm/aaaa';
		const nodes = [
			frame(1, '(root)', '', [2, 4, 5, 6, 7, 8, 9]),
			frame(2, 'wasm-function[0]', kernel, [3]),
			frame(3, 'wasm-function[7]', kernel),
			frame(4, 'Instance'),
			frame(5, 'wasm-function[3]', 'wasm://wasm/bbbb'),
			frame(6, '(idle)'),
			frame(7, '(garbage collector)'),
			frame(8, 'next', 'file:///x/ingress.ts'),
			frame(9, 'wasm-function[8]', kernel)
		];
		// 3 is under the syscall entry, 9 is kernel outside one
		const samples = [3, 3, 9, 4, 5, 5, 5, 7, 8, 8, 6];
		writeFileSync(
			join(dir, 'cell-prof-r1.cpuprofile'),
			JSON.stringify({ nodes, samples, timeDeltas: samples.map(() => 1000) })
		);
		writeFileSync(
			join(dir, 'cell-prof-r1.json'),
			JSON.stringify({
				kernelUrl: kernel,
				rounds: 10,
				statsPerRequest: {},
				boot: { wallMs: 1, cpuMs: 2 }
			})
		);
		const out = execFileSync(
			'node',
			[
				'--no-warnings',
				'--experimental-strip-types',
				join(import.meta.dirname, '../../experiments/syscall-cost/scripts/composed.ts'),
				dir,
				build
			],
			{ encoding: 'utf8' }
		);
		const row = (name: string) => out.split('\n').find((l) => l.startsWith(`| ${name}`));
		expect(out).toContain('busy samples 10 (10-10)');
		expect(row('kernel under a syscall')).toContain('| 20.0 (20.0-20.0) |');
		expect(row('kernel outside syscalls')).toContain('| 10.0 (10.0-10.0) |');
		expect(row('process start: instantiation leaves')).toContain('| 10.0 (10.0-10.0) |');
		expect(row('guest CPU')).toContain('| 30.0 (30.0-30.0) |');
		expect(row('garbage collector')).toContain('| 10.0 (10.0-10.0) |');
		expect(row('send and copy')).toContain('| 20.0 (20.0-20.0) |');
		expect(out).toContain('column sums to busy samples in every run: true');
	});
});
