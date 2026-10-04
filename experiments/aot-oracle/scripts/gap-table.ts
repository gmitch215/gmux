import { readFileSync } from 'node:fs';

/**
 * region.sh's counts-extra.csv as what a region still pays per 1,000 guest instructions: guest accesses served
 * through a window or a frame (resolved once per block entry) against those checked at the access (a generation
 * and range compare each), the window resolves, the block-to-block moves and the pending-flag reads among them,
 * and the direct calls. The last row of an arm and form wins, so a rerun replaces an earlier one.
 *
 * `gap-table.ts <counts-extra.csv>...`
 */
export interface Extra {
	workload: string;
	arm: string;
	regs: string;
	insns: number;
	entries: number;
	calls: number;
	winEnter: number;
	winAcc: number;
	chkAcc: number;
	grpAcc: number;
	cont: number;
	polls: number;
}

export function parseExtra(text: string): Extra[] {
	const last = new Map<string, Extra>();
	for (const line of text.split('\n')) {
		const f = line.split(',');
		if (f.length !== 12 || !/^\d+$/.test(f[3]!)) continue;
		const n = f.slice(3).map(Number);
		last.set(`${f[0]}:${f[1]}:${f[2]}`, {
			workload: f[0]!,
			arm: f[1]!,
			regs: f[2]!,
			insns: n[0]!,
			entries: n[1]!,
			calls: n[2]!,
			winEnter: n[3]!,
			winAcc: n[4]!,
			chkAcc: n[5]!,
			grpAcc: n[6]!,
			cont: n[7]!,
			polls: n[8]!
		});
	}
	return [...last.values()];
}

/** every figure per 1,000 guest instructions, and the share of accesses that needed no check of their own */
export function perThousand(e: Extra) {
	const k = (v: number) => (1000 * v) / e.insns;
	const access = e.winAcc + e.chkAcc + e.grpAcc;
	return {
		windowShare: access ? (e.winAcc + e.grpAcc) / access : 0,
		accesses: k(access),
		checked: k(e.chkAcc),
		resolves: k(e.winEnter),
		genCompares: k(e.winEnter + e.chkAcc),
		moves: k(e.cont),
		polls: k(e.polls),
		calls: k(e.calls),
		entries: k(e.entries)
	};
}

if (process.argv[1]?.endsWith('gap-table.ts')) {
	console.log('| workload | arm:form | accesses | windowed or grouped | checked | window resolves | generation compares | block moves | pending polls | direct calls | entries |');
	console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
	for (const path of process.argv.slice(2))
		for (const e of parseExtra(readFileSync(path, 'utf8'))) {
			const p = perThousand(e);
			const f = (v: number) => v.toFixed(1);
			console.log(
				`| ${e.workload} | ${e.arm}:${e.regs} | ${f(p.accesses)} | ${(100 * p.windowShare).toFixed(1)}% | ${f(p.checked)} | ${f(p.resolves)} | ${f(p.genCompares)} | ${f(p.moves)} | ${f(p.polls)} | ${f(p.calls)} | ${p.entries.toFixed(3)} |`
			);
		}
}
