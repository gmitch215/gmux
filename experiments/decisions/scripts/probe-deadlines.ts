import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Machine } from '../../../src/worker/machine/machine.ts';
import { siteOptions } from '../../../src/worker/site-machine.ts';

/**
 * The waits an idle machine's pump asks the host for, with and without a user timer pending: boots,
 * lets it idle, then starts `sleep 3000` and `sleep 60` and records every wait for SECONDS each.
 * `node --no-warnings --experimental-strip-types experiments/decisions/scripts/probe-deadlines.ts`
 */
const SECONDS = Number(process.env.SECONDS ?? 20);
const root = new URL('../../../', import.meta.url).pathname;
const kernel = (name: string) => new Uint8Array(readFileSync(join(root, 'build/kernel', name)));
const manifest = JSON.parse(readFileSync(join(root, 'build/kernel/manifest.json'), 'utf8'));
let output = '';
const machine = new Machine(
	siteOptions(
		{
			vmlinux: new WebAssembly.Module(kernel('vmlinux.async.wasm')),
			busybox: new WebAssembly.Module(kernel('busybox.async.wasm')),
			busyboxGuard: new WebAssembly.Module(kernel('busybox.guard.wasm')),
			katybug: new WebAssembly.Module(kernel('katybug.wasm')),
			initrd: kernel('initramfs.bin'),
			manifest
		},
		{
			sha256: (bytes) => createHash('sha256').update(bytes).digest('hex'),
			write: (text) => (output += text)
		}
	)
);
let waits: number[] = [];
const run = (ms: number, until: () => boolean = () => false) => {
	const t = Date.now();
	return machine.run(
		() => until() || Date.now() - t > ms,
		(x) => {
			waits.push(x);
			return new Promise((r) => setTimeout(r, Math.min(x, 20)));
		}
	);
};
await run(60_000, () => output.includes('# '));
const sample = async (label: string) => {
	waits = [];
	await run(SECONDS * 1000);
	const nonzero = waits.filter((w) => w > 0).sort((a, b) => a - b);
	const at = (p: number) => nonzero[Math.floor(p * (nonzero.length - 1))];
	console.log(
		JSON.stringify({
			label,
			waits: waits.length,
			nonzero: nonzero.length,
			min: nonzero[0],
			p50: at(0.5),
			p90: at(0.9),
			max: nonzero.at(-1)
		})
	);
};
await sample('idle');
await sample('idle again');
machine.type('sleep 3000 &\n');
await run(1500);
await sample('sleep 3000');
machine.type('sleep 60 &\n');
await run(1500);
await sample('sleep 3000 and 60');
process.exit(0);
