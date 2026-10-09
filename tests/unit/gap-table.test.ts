import { describe, expect, it } from 'vitest';
import { parseExtra, perThousand } from '../../experiments/aot-oracle/scripts/gap-table.ts';

const header = 'workload,arm,regs,insns,entries,calls,win_enter,win_acc,chk_acc,grp_acc,cont,polls';

describe('gap table', () => {
	it('keeps the last row of an arm and form, and skips the header', () => {
		const rows = parseExtra(
			[
				header,
				'gzip,dir,2,1000,9,9,9,9,9,9,9,9',
				'gzip,dir,2,2000,4,3,10,60,30,10,200,50',
				''
			].join('\n')
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			arm: 'dir',
			regs: '2',
			insns: 2000,
			entries: 4,
			calls: 3,
			winEnter: 10
		});
	});

	it('reads the rows with the two window columns that region.sh writes now', () => {
		const rows = parseExtra(
			[`${header},win_idx,win_slow`, 'gzip,dir,2,2000,4,3,10,60,30,10,200,50,7,1'].join('\n')
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ insns: 2000, polls: 50 });
	});

	it('reads the failed resolves and the loop revalidations of a 16-column row', () => {
		const [e] = parseExtra(
			[
				`${header},win_idx,win_slow,win_fail,reval`,
				'gzip,dir,2,2000,4,3,10,60,30,10,200,50,7,1,40,6'
			].join('\n')
		);
		expect(e).toMatchObject({ winFail: 40, reval: 6 });
		expect(perThousand(e!)).toMatchObject({ failed: 20, revalidations: 3 });
	});

	it('turns the counts into figures per 1,000 guest instructions', () => {
		const [e] = parseExtra('gzip,dir,2,2000,4,3,10,60,30,10,200,50');
		expect(perThousand(e!)).toEqual({
			failed: 0,
			revalidations: 0,
			windowShare: 0.7,
			accesses: 50,
			checked: 15,
			resolves: 5,
			genCompares: 20,
			moves: 100,
			polls: 25,
			calls: 1.5,
			entries: 2
		});
	});
});
