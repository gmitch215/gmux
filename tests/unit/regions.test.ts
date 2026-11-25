import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const pins = JSON.parse(readFileSync('src/regions.json', 'utf8')) as Record<
	string,
	{ sha256: string }
>;

const build = (...args: string[]) =>
	spawnSync('bash', ['scripts/build-regions.sh', ...args], { encoding: 'utf8' });

describe('region pins', () => {
	it('pin the four programs by sha256', () => {
		expect(Object.keys(pins).sort()).toEqual(['bash', 'busybox-amd64', 'coreutils', 'sqlite3']);
		for (const p of Object.values(pins)) expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
	});

	it('are read by pin.ts', () => {
		const run = spawnSync('scripts/ts', ['scripts/pin.ts', 'bash', 'sha256'], {
			encoding: 'utf8'
		});
		expect(run.stdout.trim()).toBe(pins.bash!.sha256);
	});
});

describe('build-regions.sh', () => {
	it('skips with a message when the program directory is missing', () => {
		const dir = mkdtempSync(join(tmpdir(), 'regions-'));
		const out = join(dir, 'out');
		const run = build(out, join(dir, 'none'));
		expect(run.status).toBe(0);
		expect(readFileSync(join(out, 'SKIPPED'), 'utf8')).toContain('no program directory');
		expect(existsSync(join(out, 'aot.c'))).toBe(false);
	});

	it('skips a program that is missing or differs from its pin and writes no table', () => {
		const dir = mkdtempSync(join(tmpdir(), 'regions-'));
		const bin = join(dir, 'bin');
		const out = join(dir, 'out');
		spawnSync('mkdir', [bin]);
		writeFileSync(join(bin, 'bash'), 'not the pinned bash');
		writeFileSync(join(bin, 'sqlite3'), 'not the pinned sqlite');
		const run = build(out, bin);
		expect(run.status).toBe(0);
		const skipped = readFileSync(join(out, 'SKIPPED'), 'utf8');
		expect(skipped).toContain('bash differs from its pin');
		expect(skipped).toContain('sqlite3 differs from its pin');
		expect(skipped).toContain('busybox-amd64 is missing');
		expect(existsSync(join(out, 'aot.c'))).toBe(false);
	});

	it('refuses an output directory that exists', () => {
		const run = build(tmpdir(), tmpdir());
		expect(run.status).toBe(1);
		expect(run.stderr).toContain('exists');
	});
});
