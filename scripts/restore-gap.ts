import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootstrapOf, type BootstrapIndex } from '../src/worker/bootstrap.ts';
import { Machine } from '../src/worker/machine/machine.ts';
import { siteOptions } from '../src/worker/site-machine.ts';
import { hostRuntime } from './wasm/router-modules.ts';

/** machine time a typed command may take to reach the next prompt */
const COMMAND_MS = 10_000;

export interface GapReading {
	/** console output from the restore to the end of the idle stretch */
	idle: string;
	/** console output of the command typed after it, up to the next prompt */
	command: string;
	crashed: boolean;
	/** the machine clock, in ms, at the restore and at the end */
	machineMs: number;
}

/**
 * Restores the bootstrap image under `assets` (`_gmux/bootstrap`) into the machine `kernel` (a
 * staged build/kernel) holds, `gapMs` of host time after its checkpoint, lets the machine run
 * `idleMs` of its own time, then (unless `command` is null) types it and runs to the next prompt. Sleeps are skipped,
 * so a 41 minute gap and 5 s of idle cost only the cpu they use. `frozen` stops the host clock
 * while the machine runs, as a deployed Worker's does
 */
export async function restoreAfterGap(
	assets: string,
	kernel: string,
	gapMs: number,
	idleMs = 5000,
	command: string | null = 'echo gate-ok',
	frozen = false
): Promise<GapReading> {
	const read = (f: string) => readFileSync(join(kernel, f));
	const manifest = JSON.parse(read('manifest.json').toString());
	const dir = join(assets, '_gmux/bootstrap');
	const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as BootstrapIndex;
	if (index.image !== manifest.image)
		throw new Error(
			`the image is for ${index.image.slice(0, 12)}, the kernel is ${manifest.image.slice(0, 12)}`
		);
	let output = '';
	const image = bootstrapOf(
		index,
		async (n) => new Uint8Array(readFileSync(join(dir, `c${n}.bin`)))
	);
	const start = BigInt(image.snapshot.now) + BigInt(gapMs) * 1_000_000n;
	const began = performance.now();
	let skipped = 0n;
	const options = {
		...siteOptions(
			{
				vmlinux: new WebAssembly.Module(read('vmlinux.async.wasm')),
				busybox: new WebAssembly.Module(read('busybox.async.wasm')),
				busyboxGuard: new WebAssembly.Module(read('busybox.guard.wasm')),
				katybug: new WebAssembly.Module(read('katybug.wasm')),
				runtime: hostRuntime(),
				initrd: new Uint8Array(read('initramfs.bin')),
				manifest
			},
			{
				sha256: (bytes) => createHash('sha256').update(bytes).digest('hex'),
				write: (text) => void (output += text)
			}
		),
		now: () =>
			start + (frozen ? 0n : BigInt(Math.round((performance.now() - began) * 1e6))) + skipped
	};
	const machine = await Machine.restore(options, image.snapshot, undefined, image.lazy);
	const sleep = async (ms: number) => void (skipped += BigInt(Math.ceil(ms)) * 1_000_000n);
	const t0 = machine.clockNs;
	await machine.run(
		() => !!machine.crashed || Number(machine.clockNs - t0) / 1e6 >= idleMs,
		sleep,
		20_000_000
	);
	const idle = output;
	output = '';
	if (command !== null) {
		machine.type(`${command}\n`);
		const typed = machine.clockNs;
		await machine.run(
			() =>
				/# $/.test(output) ||
				!!machine.crashed ||
				Number(machine.clockNs - typed) / 1e6 >= COMMAND_MS,
			sleep,
			20_000_000
		);
	}
	return {
		idle,
		command: output,
		crashed: !!machine.crashed,
		machineMs: Number(machine.clockNs - t0) / 1e6
	};
}

/** what a clean restore prints: nothing while idle, then the command's echo, its output and a prompt */
export function clean(reading: GapReading, command = 'echo gate-ok', output = 'gate-ok') {
	return (
		!reading.crashed &&
		reading.idle === '' &&
		reading.command === `${command}\r\n${output}\r\n~ # `
	);
}

/**
 * Restores the image after each gap and throws unless every restore is clean. `prompt` is whether
 * the machine sits at a shell prompt (then it also runs a command); an image taken after an init
 * is only checked for silence
 */
export async function checkRestores(
	assets: string,
	kernel: string,
	gapsS: number[],
	prompt: boolean
) {
	for (const gap of gapsS) {
		const reading = await restoreAfterGap(
			assets,
			kernel,
			gap * 1000,
			5000,
			prompt ? 'echo gate-ok' : null
		);
		if (prompt ? !clean(reading) : reading.crashed || reading.idle !== '')
			throw new Error(
				`the image printed on a restore ${gap} s after its checkpoint: ` +
					JSON.stringify((reading.idle + reading.command).slice(0, 400))
			);
	}
}
