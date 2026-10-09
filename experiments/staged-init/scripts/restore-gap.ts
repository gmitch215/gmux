import { clean, restoreAfterGap } from '../../../scripts/restore-gap.ts';

/**
 * Restores a bootstrap image after a simulated gap and reports whether the console shows an RCU
 * stall. One JSON line per gap; the exit code is 1 when any gap printed something but a clean prompt.
 * `node --no-warnings --experimental-strip-types restore-gap.ts <assets dir> <kernel dir> <gap
 * seconds>...` (IDLE_MS=5000 of machine time after the restore; FROZEN=1 stops the host clock
 * while the machine runs, as a deployed Worker's does)
 */
const [assets, kernel, ...gaps] = process.argv.slice(2);
if (!assets || !kernel || !gaps.length)
	throw new Error('usage: restore-gap.ts <assets dir> <kernel dir> <gap seconds>...');
const idleMs = Number(process.env.IDLE_MS ?? 5000);
let failed = 0;
for (const gap of gaps) {
	const began = performance.now();
	const reading = await restoreAfterGap(
		assets,
		kernel,
		Number(gap) * 1000,
		idleMs,
		undefined,
		!!process.env.FROZEN
	);
	const ok = clean(reading);
	if (!ok) failed++;
	console.log(
		JSON.stringify({
			gapSeconds: Number(gap),
			rcu: /rcu:/.test(reading.idle + reading.command),
			clean: ok,
			crashed: reading.crashed,
			idleBytes: reading.idle.length,
			head: (reading.idle + reading.command).slice(0, 160),
			wallMs: Math.round(performance.now() - began)
		})
	);
}
process.exit(failed ? 1 : 0);
