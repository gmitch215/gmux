import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Keeper, type KeeperHost } from '../../../src/worker/keeper.ts';
import type { Machine } from '../../../src/worker/machine/machine.ts';
import { sqlite } from './sqlite.ts';

/**
 * The site's keeper in node, over build/kernel's asyncified builds: boots, runs the write job for
 * a few quanta with the keeper checkpointing as the site does, drops the keeper as a replaced
 * object would, and opens a new one over the same rows: the machine must come back from storage
 * and keep running the job. Prints the idle machine's next Linux deadline at every quantum, which
 * the alarm follows, and the rows each phase wrote.
 * `node --experimental-strip-types experiments/write-back/scripts/keeper-node.ts`
 */
const root = new URL('../../../', import.meta.url).pathname;
const kernel = (name: string) => new Uint8Array(readFileSync(join(root, 'build/kernel', name)));
const manifest = JSON.parse(readFileSync(join(root, 'build/kernel/manifest.json'), 'utf8'));
const modules = {
	vmlinux: new WebAssembly.Module(kernel('vmlinux.async.wasm')),
	busybox: new WebAssembly.Module(kernel('busybox.async.wasm')),
	guard: new WebAssembly.Module(kernel('busybox.guard.wasm')),
	katybug: new WebAssembly.Module(kernel('katybug.wasm'))
};
const QUANTUM = Number(process.env.QUANTUM ?? 5000);
const QUANTA = Number(process.env.QUANTA ?? 6);

const sql = sqlite();
let alarm: number | null = null;
let output = '';
let memory: WebAssembly.Memory | undefined;
const host: KeeperHost = {
	sql,
	alarms: { getAlarm: () => alarm, setAlarm: (at) => void (alarm = at) },
	sync: async () => {},
	options: () => ({
		vmlinux: modules.vmlinux,
		initrd: kernel('initramfs.bin'),
		cmdline: 'maxcpus=3 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0',
		registry: new Map([
			[manifest.busybox, modules.busybox],
			[manifest.katybug, modules.katybug]
		]),
		guarded: new Map([[manifest.busybox, modules.guard]]),
		maximumPages: 800,
		sharedKernel: true,
		asyncify: true,
		memory,
		sha256: (bytes) => createHash('sha256').update(bytes).digest('hex'),
		write: (text) => (output = (output + text).slice(-4000))
	})
};
const run = (m: Machine, ms: number, until: () => boolean = () => false) => {
	const t = Date.now();
	return m.run(
		() => until() || Date.now() - t > ms,
		(x) => new Promise((r) => setTimeout(r, Math.min(x, 20)))
	);
};
const progress = () => Number([...output.matchAll(/W(\d+)/g)].at(-1)?.[1] ?? 0);
const held = () => {
	const gc = (globalThis as { gc?: () => void }).gc;
	if (!gc) return null;
	gc();
	const m = process.memoryUsage();
	return { heap: Math.round(m.heapUsed / 2 ** 20), external: Math.round(m.external / 2 ** 20) };
};
const deadlineMs = (m: Machine) =>
	m.deadline === null ? null : Number(m.deadline - m.clockNs) / 1e6;

let keeper = new Keeper(host);
let { machine, from } = await keeper.open();
memory = machine.memory;
await run(machine, 60_000, () => output.includes('# '));
const bootRows = sql.written;
const idle: (number | null)[] = [];
for (let i = 0; i < 3; i++) {
	await run(machine, 1000);
	idle.push(deadlineMs(machine));
}
machine.type(
	'mkdir -p /data; x=$(seq 1 8000); i=0; while :; do f=/data/f$((i % 16)); echo "$i $x" > $f; ' +
		'[ $((i % 256)) = 0 ] && fsync $f; i=$((i + 1)); [ $((i % 64)) = 0 ] && echo W$i; done &\n'
);
const quanta: object[] = [];
for (let q = 0; q < QUANTA; q++) {
	const before = sql.written;
	const outcome = await run(keeper.machine!, QUANTUM);
	const written = await keeper.ran(QUANTUM);
	quanta.push({
		q,
		outcome,
		rows: sql.written - before,
		checkpoint: written,
		refused: keeper.last.refused,
		progress: progress(),
		deadlineMs: deadlineMs(keeper.machine!),
		alarmInMs: alarm === null ? null : alarm - Date.now(),
		// what V8 holds after a full collection (node --expose-gc): a rough guide to an isolate's
		heldMiB: held()
	});
}
const beforeLoss = progress();
const checkpoints = keeper.counts.checkpoints;
// a replaced object: the machine and keeper are gone, the rows stay
keeper = null as unknown as Keeper;
output = '';
const lossRows = sql.written;
keeper = new Keeper(host);
({ machine, from } = await keeper.open());
await run(machine, QUANTUM * 2);
const after = progress();
const result = {
	bootRows,
	idleDeadlinesMs: idle,
	quanta,
	checkpoints,
	refused: keeper.counts.refused,
	reopenedFrom: from,
	restoreRows: sql.written - lossRows,
	progressBeforeLoss: beforeLoss,
	progressAfterRestore: after,
	filesRestored: machine.stats.filesRestored,
	restoreErrors: machine.stats.fileRestoreErrors,
	tail: output.slice(-200)
};
console.log(JSON.stringify(result, null, 1));
const pass = checkpoints > 0 && from === 'restored' && after > 0;
console.log(pass ? 'PASS keeper restores' : 'FAIL keeper restores');
process.exit(pass ? 0 : 1);
