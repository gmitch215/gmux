import { describe, expect, it } from 'vitest';
import { parseRows, table } from '../../experiments/aot-oracle/scripts/epochs-regions.ts';

const extra = [
	'workload,arm,regs,insns,entries,calls,win_enter,win_acc,chk_acc,grp_acc,cont,polls',
	'gzip,fnc,0,1000000,10,0,60000,100000,40000,0,120000,30000',
	'gzip,fnc+ep,0,1000000,10,0,60000,100000,40000,0,120000,0',
	'gzip,fnc,0,2000000,20,0,120000,200000,80000,0,240000,60000'
].join('\n');
const epochs = [
	'workload,arm,regs,insns,ep_in,ep_slow,ep_back',
	'gzip,fnc,0,2000000,0,0,0',
	'gzip,fnc+ep,0,1000000,10,2,29000'
].join('\n');

describe('epochs regions table', () => {
	it('keeps the last row of an arm and form and joins the epoch counters by name', () => {
		const rows = parseRows(extra, epochs);
		expect(rows.map((r) => [r.arm, r.insns])).toEqual([
			['fnc', 2000000],
			['fnc+ep', 1000000]
		]);
		expect(rows[1]).toMatchObject({ epIn: 10, epSlow: 2, epBack: 29000, polls: 0 });
	});

	it('counts the generation compares and polls removed per 1,000 instructions', () => {
		const [, , line] = table(parseRows(extra, epochs));
		// before: (60000 + 40000 + 30000) / 1e6 -> 130.0; after: (10 + 29000) / 1e6 -> 29.0
		expect(line!.split('|').map((c) => c.trim())).toContain('130.0');
		expect(line).toContain('| 29.0 | 101.0 |');
	});

	it('leaves out an arm that has no epoch pair', () => {
		expect(table(parseRows(extra.split('\n').slice(0, 2).join('\n'), epochs))).toHaveLength(2);
	});
});
