import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Machine, type MachineOptions } from '../../../src/worker/machine/machine.ts';

/**
 * A console flood checkpointed in the middle: `seq 1 200000` runs on the asyncify kernel, the machine
 * is checkpointed once CUT bytes of output (default 400,000) have been written, restored into a new
 * machine, and run to the end. The output from the typed command to its marker must hash like the
 * same run with no checkpoint, whether the ring is on or off (RING=off turns it off).
 * GMUX_BUILD picks the build (default build/).
 * `node --no-warnings --experimental-strip-types experiments/event-batching/scripts/flood.ts`
 */
const root = new URL('../../../', import.meta.url).pathname;
const kernel = join(process.env.GMUX_BUILD ?? join(root, 'build'), 'kernel');
const manifest = JSON.parse(readFileSync(join(kernel, 'manifest.json'), 'utf8'));
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const ring = process.env.RING === 'off' ? false : undefined;
const cut = Number(process.env.CUT ?? 400_000);
const vmlinux = new WebAssembly.Module(readFileSync(join(kernel, 'vmlinux.async.wasm')));
const busybox = new WebAssembly.Module(readFileSync(join(kernel, 'busybox.async.wasm')));
const COMMAND = 'seq 1 200000; echo "== done-$((6*7))"\n';

async function flood(checkpointAt: number | null) {
	let output = '';
	const options: MachineOptions = {
		vmlinux,
		initrd: new Uint8Array(readFileSync(join(kernel, 'initramfs.bin'))),
		cmdline: 'maxcpus=3 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0',
		registry: new Map([[manifest.busybox, busybox]]),
		maximumPages: 4096,
		sha256,
		sharedKernel: true,
		asyncify: true,
		...(ring === undefined ? {} : { consoleRing: ring }),
		write: (text) => (output += text)
	};
	const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 5)));
	const until = async (machine: Machine, done: () => boolean) => {
		const t = Date.now();
		await machine.run(() => done() || Date.now() - t > 600_000, sleep);
		if (!done()) throw new Error(`stuck: ${output.slice(-200)}`);
	};
	let machine = new Machine(options);
	await until(machine, () => output.includes('# '));
	const start = output.length;
	machine.type(COMMAND);
	let restored = false;
	if (checkpointAt !== null) {
		await until(machine, () => output.length - start >= checkpointAt);
		const snapshot = await machine.checkpoint();
		machine = await Machine.restore(options, snapshot);
		restored = true;
	}
	await until(machine, () => output.slice(start).includes('== done-42\r\n'));
	// the prompt after the marker lands in this step or the next, by timing
	const marker = '== done-42\r\n';
	const text = output
		.slice(start, output.indexOf(marker, start) + marker.length)
		.replace(/\r/g, '');
	return {
		sha: sha256(new TextEncoder().encode(text)),
		bytes: text.length,
		restored,
		puts: machine.stats.consolePuts,
		drains: machine.stats.consoleDrains,
		crashed: String(machine.crashed)
	};
}

const plain = await flood(null);
const cutRun = await flood(cut);
console.log(
	JSON.stringify({
		ring: ring === false ? 'off' : 'default',
		cut,
		uninterrupted: plain,
		checkpointed: cutRun,
		equal: plain.sha === cutRun.sha && plain.crashed === 'null' && cutRun.crashed === 'null'
	})
);
process.exit(plain.sha === cutRun.sha ? 0 : 1);
