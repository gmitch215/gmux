import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const arrays = (name: string, imm: number) =>
	`static const struct kb_ins ${name}[] = {\n\t{18, 4, 33, 8, 0, (int64_t) 0x${imm.toString(16)}ull},\n};\n`;
const entry = (pc: number, next: number, region: number, name: string) =>
	`\t{0x${pc.toString(16)}ull, 0x${next.toString(16)}ull, 0x0ull, 1, ${region}, 0, ${name}, NULL},\n`;

function collisions(entries: string, ir: [string, number][], labels: string) {
	const file = join(mkdtempSync(join(tmpdir(), 'collide-')), 'lifted.c');
	writeFileSync(
		file,
		ir.map(([n, v]) => arrays(n, v)).join('') +
			`static const struct aot_entry aot_table[] = {\n${entries}};\n`
	);
	const run = spawnSync(
		process.execPath,
		[
			'--no-warnings',
			'--experimental-strip-types',
			'experiments/aot-oracle/scripts/table-collisions.ts',
			file,
			labels
		],
		{ encoding: 'utf8' }
	);
	expect(run.status).toBe(0);
	return run.stdout;
}

describe('table-collisions', () => {
	it('counts a pc in two ELFs and whether the pair is equal to the attach guard', () => {
		const out = collisions(
			entry(0x1000, 0x1010, 0, 'a_i0') +
				entry(0x1000, 0x1010, 1, 'b_i0') +
				entry(0x2000, 0x2010, 0, 'a_i1') +
				entry(0x2000, 0x2010, 1, 'b_i1') +
				entry(0x3000, 0x3010, 0, 'a_i0'),
			[
				['a_i0', 1],
				['b_i0', 1],
				['a_i1', 1],
				['b_i1', 2]
			],
			'0:busybox,1:sqlite'
		);
		expect(out).toContain('5 entries, 3 distinct pcs; per ELF: busybox 3, sqlite 2');
		expect(out).toContain('pcs in more than one ELF: 2 (equal next, target, ops and IR: 1)');
	});

	it('keeps two regions of one ELF apart from a collision between ELFs', () => {
		const out = collisions(
			entry(0x1000, 0x1010, 0, 'a_i0') + entry(0x1000, 0x1010, 1, 'a_i0'),
			[['a_i0', 1]],
			'0-1:busybox'
		);
		expect(out).toContain(
			'pcs in more than one ELF: 0 (equal next, target, ops and IR: 0); pcs in two regions of one ELF: 1'
		);
	});
});
