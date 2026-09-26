import { get, record, sleep, Socket } from '../../../scripts/probe.ts';

async function g3Burns(itersPerMessage: number, messages: number, chunk: number, mode = 'std') {
	const s = await Socket.open(`do=burns-${Date.now()}&mode=${mode}`);
	const rows: object[] = [];
	for (let i = 0; i < messages; i++) {
		s.send({
			op: 'burn',
			iters: itersPerMessage,
			chunk,
			quiet: process.env.QUIET === '1',
			yieldQuiet: process.env.YIELD_QUIET === '1'
		});
		const { msg, lastProgress } = await s.until(['burned'], 180_000);
		rows.push({
			message: i,
			result: msg.op,
			iters: msg.iters,
			lastProgress: lastProgress?.done ?? null,
			instance: msg.instance
		});
		if (msg.op !== 'burned') break;
	}
	s.close();
	record('quanta', { arm: `websocket-per-message-${mode}`, itersPerMessage, messages, chunk, rows });
}

async function g3KillPoint(iters: number, chunk: number) {
	const s = await Socket.open(`do=kill-${Date.now()}&mode=std`);
	s.send({ op: 'burn', iters, chunk });
	const { msg, lastProgress } = await s.until(['burned'], 300_000);
	s.close();
	record('quanta', {
		arm: 'kill-point',
		iters,
		chunk,
		outcome: msg,
		lastProgress: lastProgress?.done ?? null
	});
}

async function g3Quantum(chunks: number, chunk: number, quantum: number) {
	const mode = process.env.MODE ?? 'std';
	const s = await Socket.open(
		`do=${process.env.DO_NAME ?? `quantum-${Date.now()}`}&mode=${mode}`
	);
	s.send({ op: 'quantum-start', chunks, chunk, quantum });
	const steps: any[] = [];
	for (;;) {
		const m = await s.next(180_000);
		steps.push({
			kind: m.kind ?? m.op,
			c: m.c,
			x: m.x,
			instance: m.instance,
			reason: m.reason
		});
		if (m.op !== 'quantum' || m.kind !== 'yielded') break;
		if (process.env.GAP_MS) await sleep(Number(process.env.GAP_MS));
		s.send({ op: 'quantum-continue' });
	}
	const last = steps[steps.length - 1];
	record('quanta', {
		arm: `quantum-${mode}`,
		gapMs: Number(process.env.GAP_MS ?? 0),
		chunks,
		chunk,
		quantum,
		events: steps.length,
		finished: last?.kind === 'finished',
		x: last?.x ?? null,
		instances: [...new Set(steps.map((s) => s.instance))],
		steps
	});
	return last?.x ?? null;
}

async function g3Reference(chunks: number, chunk: number) {
	const s = await Socket.open(`do=ref-${Date.now()}&mode=std`);
	s.send({ op: 'reference', chunks, chunk });
	const m = await s.next(180_000);
	s.close();
	return m.x ?? null;
}

async function g3AlarmBurns(iters: number, times: number, chunk: number) {
	const name = process.env.DO_NAME ?? `alarm-${Date.now()}`;
	const s = await Socket.open(`do=${name}&mode=std`);
	await get(`/alarm-burn?do=${name}&iters=${iters}&times=${times}&chunk=${chunk}`);
	const rows: object[] = [];
	for (let i = 0; i < times; i++) {
		const { msg, lastProgress } = await s.until(['alarm-burned'], 300_000);
		rows.push({
			alarm: i,
			result: msg.op,
			remaining: msg.remaining,
			lastProgress: lastProgress?.done ?? null,
			instance: msg.instance
		});
		if (msg.op !== 'alarm-burned') break;
	}
	s.close();
	record('quanta', { arm: 'alarm-per-event', iters, times, chunk, rows });
}

const [cmd, ...args] = process.argv.slice(2);
const n = (i: number, fallback: number) => Number(args[i] ?? fallback);

switch (cmd) {
	case 'burns':
		await g3Burns(n(0, 1e9), n(1, 3), n(2, 1e8), args[3] ?? 'std');
		break;
	case 'kill':
		await g3KillPoint(n(0, 4e10), n(1, 2e8));
		break;
	case 'quantum': {
		const x = await g3Quantum(n(0, 20), n(1, 1e8), n(2, 5));
		if (args[3] === 'verify')
			record('quanta', {
				arm: 'quantum-verify',
				quantumX: x,
				referenceX: await g3Reference(n(0, 20), n(1, 1e8))
			});
		break;
	}
	case 'alarm':
		await g3AlarmBurns(n(0, 1e9), n(1, 3), n(2, 1e8));
		break;
	default:
		console.error(
			'usage: node --experimental-strip-types scripts/drive.ts <burns|kill|quantum|alarm> [args]'
		);
		process.exit(2);
}
process.exit(0);
