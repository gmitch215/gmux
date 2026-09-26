import { get, record, sleep, Socket } from '../../../scripts/probe.ts';

async function g2Socket(mode: 'std' | 'hib', idleMs: number) {
	const name = `${mode}-${idleMs}-${Date.now()}`;
	const s = await Socket.open(`do=${name}&mode=${mode}`);
	s.send({ op: 'park', tasks: 4, iters: 3, depth: 8 });
	const parked = await s.next();
	await sleep(idleMs);
	s.send({ op: 'resume' });
	const resumed = await s.next();
	s.close();
	record('residency', {
		arm: `websocket-${mode}`,
		idleMs,
		parked: parked.parked,
		ok: resumed.ok ?? false,
		reason: resumed.reason ?? null,
		sameInstance: parked.instance === resumed.instance,
		parkedMsg: parked,
		resumedMsg: resumed
	});
}

async function g2Alarm(delayMs: number) {
	const name = `alarm-${delayMs}-${Date.now()}`;
	const park = await get(`/alarm-park?do=${name}&delay=${delayMs}`);
	await sleep(delayMs + 15_000);
	const result = await get(`/alarm-result?do=${name}`);
	record('residency', {
		arm: 'alarm',
		delayMs,
		parked: park.parked,
		ok: result.result?.ok ?? false,
		reason: result.result?.reason ?? null,
		sameInstance: park.instance === result.result?.instance,
		park,
		result
	});
}

const [cmd, ...args] = process.argv.slice(2);
const n = (i: number, fallback: number) => Number(args[i] ?? fallback);

switch (cmd) {
	case 'std':
		await g2Socket('std', n(0, 10_000));
		break;
	case 'hib':
		await g2Socket('hib', n(0, 10_000));
		break;
	case 'alarm':
		await g2Alarm(n(0, 5000));
		break;
	default:
		console.error(
			'usage: node --experimental-strip-types scripts/drive.ts <std|hib|alarm> [args]'
		);
		process.exit(2);
}
process.exit(0);
