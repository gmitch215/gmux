import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { routerModules } from '../../../scripts/wasm/router-modules.ts';
import { decodeSnapshot, DurableStore, encodeSnapshot } from '../../../src/worker/durable.ts';
import { Machine, type MachineOptions } from '../../../src/worker/machine/machine.ts';
import { Cadence } from '../../../src/worker/schedule.ts';
import { sqlite } from './sqlite.ts';

/**
 * The deployed rig's two arms under Node, for the same quanta: rows written and host CPU for a
 * write-heavy and a CPU-heavy job, checkpointed every quantum (every row replaced, whole memory)
 * or written back at the adaptive interval with exact fsyncs.
 * `node --experimental-strip-types experiments/write-back/scripts/arms.ts <write|cpu> <quantum|writeback> [quanta]`
 */
const root = new URL('../../../', import.meta.url).pathname;
const vendor = join(root, 'experiments/boot/vendor');
const read = (name: string) => new Uint8Array(readFileSync(join(vendor, name)));
const manifest = JSON.parse(readFileSync(join(root, 'build/kernel/manifest.json'), 'utf8'));
const [job = 'write', arm = 'writeback', quantaArg = '24'] = process.argv.slice(2);
const JOBS: Record<string, string> = {
	write:
		'mkdir -p /data; x=$(seq 1 8000); i=0; while :; do f=/data/f$((i % 16)); echo "$i $x" > $f; ' +
		'[ $((i % 256)) = 0 ] && fsync $f; i=$((i + 1)); [ $((i % 64)) = 0 ] && echo W$i; done &',
	cpu: 'i=0; while :; do i=$((i + 1)); [ $((i % 5000)) = 0 ] && echo C$i; done &'
};
const ROW = 2_000_000;
const vmlinux = new WebAssembly.Module(read('vmlinux.async.wasm'));
const busybox = new WebAssembly.Module(read('busybox.async.wasm'));

const sql = sqlite();
sql.exec('CREATE TABLE IF NOT EXISTS image (k INTEGER PRIMARY KEY, v BLOB)');
sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)');
const store = new DurableStore(sql);
const cadence = new Cadence();
let output = '';
let fsyncs = 0;
const options = (): MachineOptions => ({
	vmlinux,
	initrd: read('initramfs.bin'),
	cmdline: 'maxcpus=3 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0',
	registry: new Map([[manifest.busybox, busybox]]),
	maximumPages: Number(process.env.PAGES ?? 2048),
	sha256: (bytes) => createHash('sha256').update(bytes).digest('hex'),
	sharedKernel: true,
	asyncify: true,
	router: routerModules(),
	write: (text) => (output = (output + text).slice(-20000)),
	fileSync:
		arm === 'writeback'
			? async (file) => {
					store.writeFile(file);
					fsyncs++;
				}
			: undefined
});
const run = (m: Machine, ms: number, until = () => false) => {
	const t = Date.now();
	return m.run(
		() => until() || Date.now() - t > ms,
		(x) => new Promise((r) => setTimeout(r, Math.min(x, 20)))
	);
};
const progress = () => {
	const all = [...output.matchAll(/[WC](\d+)/g)];
	return all.length ? Number(all.at(-1)![1]) : 0;
};

let machine = new Machine(options());
await run(machine, 60_000, () => output.includes('# '));
machine.type(`${JOBS[job]}\n`);
await run(machine, 2000);
const cpu0 = process.cpuUsage();
const t0 = Date.now();
let checkpoints = 0;
let checkpointMs = 0;
const rows0 = sql.written;
// LOSE_EVERY=n drops the machine before every nth quantum and restores it from storage, as a
// replaced instance does
const loseEvery = Number(process.env.LOSE_EVERY ?? 0);
let losses = 0;
let lossMs = 0;
for (let q = 0; q < Number(quantaArg); q++) {
	if (loseEvery && q && q % loseEvery === 0 && checkpoints) {
		const l0 = Date.now();
		if (arm === 'quantum') {
			const text = String(sql.exec("SELECT v FROM meta WHERE k = 'snapshot'").toArray()[0]!.v);
			const n = Number(sql.exec('SELECT count(*) AS n FROM image').toArray()[0]!.n);
			machine = await Machine.restore(options(), decodeSnapshot(text), {
				byteLength: machine.memory.buffer.byteLength,
				write: (into) => {
					for (let k = 0; k < n; k++)
						into.set(
							sql.exec('SELECT v FROM image WHERE k = ?', k).toArray()[0]!.v as Uint8Array,
							k * ROW
						);
				}
			});
		} else {
			const recovery = store.recover()!;
			machine = await Machine.restore(
				{ ...options(), restoreFiles: recovery.files },
				decodeSnapshot(recovery.snapshot),
				recovery.image
			);
			cadence.lost();
		}
		losses++;
		lossMs += Date.now() - l0;
	}
	await run(machine, 5000);
	const c0 = Date.now();
	if (arm === 'quantum') {
		const snapshot = await machine.checkpoint();
		sql.exec('DELETE FROM image');
		let n = 0;
		for (let at = 0; at < snapshot.memory.byteLength; at += ROW)
			sql.exec('INSERT INTO image (k, v) VALUES (?, ?)', n++, snapshot.memory.slice(at, at + ROW));
		sql.exec('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)', 'snapshot', encodeSnapshot(snapshot));
		const length = snapshot.memory.byteLength;
		const text = String(sql.exec("SELECT v FROM meta WHERE k = 'snapshot'").toArray()[0]!.v);
		machine = await Machine.restore({ ...options(), memory: machine.memory }, decodeSnapshot(text), {
			byteLength: length,
			write: (into) => {
				let at = 0;
				for (const r of sql.exec('SELECT v FROM image ORDER BY k').toArray()) {
					const chunk = new Uint8Array(r.v as Uint8Array);
					into.set(chunk, at);
					at += chunk.byteLength;
				}
			}
		});
		checkpoints++;
	} else {
		cadence.ran(5000);
		if (cadence.due) {
			const snapshot = await machine.checkpoint();
			const cost = store.writeCheckpoint(snapshot.memory, encodeSnapshot(snapshot));
			const recovery = store.recover()!;
			machine = await Machine.restore(
				{ ...options(), restoreFiles: recovery.files, memory: machine.memory },
				decodeSnapshot(recovery.snapshot),
				recovery.image
			);
			const mib = snapshot.memory.byteLength / (1 << 20);
			cadence.checkpointed(50 + 2 * mib + 0.2 * cost.changed, cost.rows);
			checkpoints++;
		}
	}
	checkpointMs += Date.now() - c0;
	console.log(JSON.stringify({ q, rows: sql.written - rows0, checkpoints, fsyncs, progress: progress(), interval: Math.round(cadence.interval) }));
}
const cpu = process.cpuUsage(cpu0);
const wall = Date.now() - t0;
console.log(
	JSON.stringify({
		job,
		arm,
		quanta: Number(quantaArg),
		wallMs: wall,
		cpuMs: Math.round((cpu.user + cpu.system) / 1000),
		checkpointMs,
		rows: sql.written - rows0,
		checkpoints,
		fsyncs,
		losses,
		lossMs,
		progress: progress(),
		rowsPerHour: Math.round(((sql.written - rows0) * 3_600_000) / (Number(quantaArg) * 5000)),
		tail: process.env.FULL ? output : output.slice(-200)
	})
);
