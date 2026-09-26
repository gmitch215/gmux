import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Machine } from '../../../src/worker/machine/machine.ts';

/**
 * what a machine pays for executables in its rootfs: full files against exec stubs
 * (scripts/wasm/exec-stubs.ts). Per arm and round, a fresh boot: guest MemFree, 300 execs of
 * /bin/busybox true (host ms), and the checkpoint image's non-zero pages and gzip size.
 * `node --experimental-strip-types experiments/exec-stubs/scripts/measure.ts <full initrd> <stub initrd> [rounds]`
 */
const root = new URL('../../../', import.meta.url).pathname;
const dir = join(root, 'build/kernel');
const [full, stub, rounds = '3'] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
const vmlinux = new WebAssembly.Module(readFileSync(join(dir, 'vmlinux.wasm')));
const busybox = new WebAssembly.Module(readFileSync(join(dir, 'busybox.wasm')));

async function arm(initrd: string) {
	let output = '';
	let hashed = 0;
	const machine = new Machine({
		vmlinux,
		initrd: new Uint8Array(readFileSync(initrd)),
		cmdline:
			'maxcpus=3 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0',
		registry: new Map([[manifest.busybox, busybox]]),
		maximumPages: 1024,
		sha256: (bytes) => (hashed++, createHash('sha256').update(bytes).digest('hex')),
		sharedKernel: true,
		write: (text) => (output += text)
	});
	const run = (until: () => boolean) =>
		machine.run(until, (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))));
	const command = async (text: string) => {
		const start = output.length;
		machine.type(`${text}; echo __DO""NE__\n`);
		await run(() => /__DONE__\r?\n/.test(output.slice(start)));
		return output.slice(start).replace(/\r/g, '');
	};
	await run(() => output.includes('# '));
	const meminfo = await command('grep -e MemFree -e MemAvailable /proc/meminfo');
	const kb = (key: string) => Number(new RegExp(`${key}:\\s+(\\d+)`).exec(meminfo)?.[1]);
	const execs = machine.stats.userExecs;
	const hashes = hashed;
	const t = performance.now();
	await command('i=0; while [ $i -lt 300 ]; do /bin/busybox true; i=$((i+1)); done');
	const loopMs = performance.now() - t;
	// the bytes a checkpoint image carries
	const image = new Uint8Array(machine.memory.buffer).slice();
	let nonZero = 0;
	const words = new BigUint64Array(image.buffer);
	for (let page = 0; page < words.length; page += 512)
		if (words.subarray(page, page + 512).some((w) => w !== 0n)) nonZero++;
	return {
		memFreeKiB: kb('MemFree'),
		memAvailableKiB: kb('MemAvailable'),
		execs: machine.stats.userExecs - execs,
		hashes: hashed - hashes,
		loopMs: Math.round(loopMs),
		nonZeroPages: nonZero,
		imageGzipBytes: gzipSync(image, { level: 1 }).length
	};
}

for (let r = 0; r < Number(rounds); r++)
	for (const [name, initrd] of [['full', full], ['stub', stub]] as const)
		console.log(JSON.stringify({ round: r, arm: name, ...(await arm(initrd!)) }));
