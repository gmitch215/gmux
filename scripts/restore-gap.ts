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

function openImage(assets: string, kernel: string) {
	const read = (f: string) => readFileSync(join(kernel, f));
	const manifest = JSON.parse(read('manifest.json').toString());
	const dir = join(assets, '_gmux/bootstrap');
	const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as BootstrapIndex;
	if (index.image !== manifest.image)
		throw new Error(
			`the image is for ${index.image.slice(0, 12)}, the kernel is ${manifest.image.slice(0, 12)}`
		);
	let output = '';
	return {
		image: bootstrapOf(
			index,
			async (n) => new Uint8Array(readFileSync(join(dir, `c${n}.bin`)))
		),
		build: {
			vmlinux: new WebAssembly.Module(read('vmlinux.async.wasm')),
			busybox: new WebAssembly.Module(read('busybox.async.wasm')),
			busyboxGuard: new WebAssembly.Module(read('busybox.guard.wasm')),
			katybug: new WebAssembly.Module(read('katybug.wasm')),
			runtime: hostRuntime(),
			initrd: new Uint8Array(read('initramfs.bin')),
			manifest
		},
		host: {
			sha256: (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex'),
			write: (text: string) => void (output += text)
		},
		peek: () => output,
		take: () => {
			const text = output;
			output = '';
			return text;
		}
	};
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
	const { image, build, host, take, peek } = openImage(assets, kernel);
	const start = BigInt(image.snapshot.now) + BigInt(gapMs) * 1_000_000n;
	const began = performance.now();
	let skipped = 0n;
	const options = {
		...siteOptions(build, host),
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
	const idle = take();
	if (command !== null) {
		machine.type(`${command}\n`);
		const typed = machine.clockNs;
		await machine.run(
			() =>
				/# $/.test(peek()) ||
				!!machine.crashed ||
				Number(machine.clockNs - typed) / 1e6 >= COMMAND_MS,
			sleep,
			20_000_000
		);
	}
	return {
		idle,
		command: take(),
		crashed: !!machine.crashed,
		machineMs: Number(machine.clockNs - t0) / 1e6
	};
}

/**
 * Restores the image, then `rounds` times removes a few files at the prompt, checkpoints at once
 * (while the inodes' RCU grace period is open), restores that checkpoint `gapMs` of host time later
 * and lets it idle `idleMs`. Returns one reading per round; a restore of a checkpoint taken with a
 * grace period open on a kernel that does not bring jiffies up to the clock prints a stall report
 */
export async function restoreChain(
	assets: string,
	kernel: string,
	rounds: number,
	gapMs = 30_000,
	idleMs = 5000
): Promise<GapReading[]> {
	const { image, build, host, take, peek } = openImage(assets, kernel);
	let skipped = 0n;
	let start = BigInt(image.snapshot.now);
	let began = performance.now();
	const options = {
		...siteOptions(build, host),
		now: () => start + BigInt(Math.round((performance.now() - began) * 1e6)) + skipped
	};
	const sleep = async (ms: number) => void (skipped += BigInt(Math.ceil(ms)) * 1_000_000n);
	const runFor = (machine: Machine, ms: number) => {
		const t0 = machine.clockNs;
		return machine.run(
			() => !!machine.crashed || Number(machine.clockNs - t0) / 1e6 >= ms,
			sleep,
			20_000_000
		);
	};
	let machine = await Machine.restore(options, image.snapshot, undefined, image.lazy);
	const readings: GapReading[] = [];
	for (let round = 0; round < rounds; round++) {
		// a file removed frees its inode through call_rcu, so the checkpoint lands while a grace period is open
		machine.type('for i in 1 2 3 4 5 6; do touch /g$i; rm /g$i; done\n');
		await machine.run(() => !!machine.crashed || /# $/.test(peek()), sleep, 20_000_000);
		if (machine.crashed) {
			readings.push({ idle: take(), command: '', crashed: true, machineMs: 0 });
			break;
		}
		const snapshot = await machine.checkpoint();
		take();
		start = BigInt(snapshot.now) + BigInt(gapMs) * 1_000_000n;
		began = performance.now();
		skipped = 0n;
		machine = await Machine.restore(options, snapshot);
		const t0 = machine.clockNs;
		await runFor(machine, idleMs);
		readings.push({
			idle: take(),
			command: '',
			crashed: !!machine.crashed,
			machineMs: Number(machine.clockNs - t0) / 1e6
		});
		if (machine.crashed) break;
	}
	return readings;
}

/** what a clean restore prints: nothing while idle, then the command's echo, its output and a prompt */
export function clean(reading: GapReading, command = 'echo gate-ok', output = 'gate-ok') {
	return (
		!reading.crashed &&
		reading.idle === '' &&
		reading.command === `${command}\r\n${output}\r\n~ # `
	);
}

/** the index of the first reading that crashed or printed while idle, or -1 */
export const firstNoisy = (readings: GapReading[]) =>
	readings.findIndex((r) => r.crashed || r.idle !== '');

/**
 * Restores the image after each gap and throws unless every restore is clean. `prompt` is whether
 * the machine sits at a shell prompt (then it also runs a command, and `chain` checkpoints of it
 * are restored too); an image taken after an init is only checked for silence
 */
export async function checkRestores(
	assets: string,
	kernel: string,
	gapsS: number[],
	prompt: boolean,
	chain = 0
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
	if (!prompt || !chain) return;
	const readings = await restoreChain(assets, kernel, chain);
	const bad = firstNoisy(readings);
	if (bad >= 0)
		throw new Error(
			`the image printed on a restore of its checkpoint ${bad + 1} of ${chain}: ` +
				JSON.stringify(readings[bad]!.idle.slice(0, 400))
		);
}
