import { get, record } from '../../../scripts/probe.ts';

const [cmd, ...args] = process.argv.slice(2);
const n = (i: number, fallback: number) => Number(args[i] ?? fallback);

switch (cmd) {
	case 'parks':
		record('parks', {
			arm: 'jspi-two-instances',
			...(await get(
				`/parks?tasks=${n(0, 4)}&iters=${n(1, 250)}&depth=${n(2, 16)}&do=parks-${Date.now()}`
			))
		});
		break;
	case 'memory':
		record('parks', {
			arm: 'parked-stack-memory',
			...(await get(
				`/memory?tasks=${n(0, 100)}&depth=${n(1, 0)}&do=memory-${Date.now()}`
			).catch((e) => ({ error: String(e) })))
		});
		break;
	case 'wasm3':
		record('parks', {
			arm: 'wasm3-suspending-import',
			...(await get(
				`/wasm3?interps=${n(0, 1)}&iters=${n(1, 1000)}&depth=${n(2, 4)}&do=wasm3-${Date.now()}`
			))
		});
		break;
	default:
		console.error(
			'usage: node --experimental-strip-types scripts/drive.ts <parks|memory|wasm3> [args]'
		);
		process.exit(2);
}
process.exit(0);
