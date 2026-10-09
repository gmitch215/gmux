import binaryen from 'binaryen';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { uleb } from '../../scripts/wasm/binary.ts';
import { stub } from '../../scripts/wasm/exec-stubs.ts';
import { hostRuntime } from '../../scripts/wasm/router-modules.ts';
import { Ingress, READ_BUFFER, type NetStats } from '../../src/worker/machine/ingress.ts';
import {
	Machine,
	statxHash,
	stubHash,
	type MachineOptions,
	type SyncedFile
} from '../../src/worker/machine/machine.ts';
import {
	FS_CHAIN,
	FS_COUNTERS,
	FS_MOVES,
	FS_PATH,
	MISS,
	ROUTE_HOOK,
	ROUTE_KERNEL,
	ROUTE_WATCH,
	ROUTE_WRITES,
	STATX_GUARDS,
	statxBucket
} from '../../src/worker/machine/router.ts';

const RUNTIME = hostRuntime();

const PARK_IMPORTS = [
	'wasm_serialize_tasks',
	'wasm_create_and_run_task',
	'wasm_idle_wait',
	'wasm_cpu_relax',
	'wasm_halt',
	'wasm_user_mode_tail'
];

/**
 * tests/fixtures/toy-kernel.wat speaks linux-wasm's host ABI with two tasks: init boots, forks a
 * child and idles on a 1 ms deadline polling the console; input "s" switches to the child and back,
 * "q" halts. Both tasks print whether `current` still holds their own id after every switch
 */
function toyKernel(asyncify: boolean): WebAssembly.Module {
	const module = parse('toy-kernel.wat');
	module.setFeatures(
		binaryen.Features.Atomics |
			binaryen.Features.MutableGlobals |
			binaryen.Features.BulkMemory |
			binaryen.Features.BulkMemoryOpt
	);
	if (asyncify) {
		binaryen.setPassArgument(
			'asyncify-imports',
			PARK_IMPORTS.map((name) => `env.${name}`).join(',')
		);
		module.runPasses(['asyncify']);
	}
	const bytes = module.emitBinary();
	module.dispose();
	return new WebAssembly.Module(bytes);
}

function parse(name: string) {
	return binaryen.parseText(
		readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')
	);
}

/**
 * tests/fixtures/toy-user.wat ("u" on the toy kernel's console), toy-vfork.wat ("v"),
 * toy-fault.wat ("f"), toy-spin.wat ("i"), toy-overflow.wat ("o") or toy-mmu.wat ("m")
 */
function toyUser(name = 'toy-user.wat', asyncify = false, data?: number): WebAssembly.Module {
	const module = parse(name);
	module.setFeatures(
		binaryen.Features.Atomics | binaryen.Features.MutableGlobals | binaryen.Features.MultiMemory
	);
	// instrument.sh's gmux.data note
	if (data !== undefined)
		module.addCustomSection('gmux.data', new Uint8Array(new Uint32Array([data]).buffer));
	if (asyncify) {
		binaryen.setPassArgument('asyncify-imports', 'env.__wasm_syscall_*');
		module.runPasses(['asyncify']);
	}
	const bytes = module.emitBinary();
	module.dispose();
	return new WebAssembly.Module(bytes);
}

/** tests/fixtures/toy-shared.wat with share.ts's mark: 16 bytes of data */
function toyShared(): WebAssembly.Module {
	const module = parse('toy-shared.wat');
	module.setFeatures(binaryen.Features.Atomics | binaryen.Features.MutableGlobals);
	module.addCustomSection('gmux.share', new Uint8Array([16, 0, 0, 0]));
	const bytes = module.emitBinary();
	module.dispose();
	return new WebAssembly.Module(bytes);
}

/** a toy user program built with experiments/evacuation/scripts/evacuate.ts --resume */
function evacuated(name: string): WebAssembly.Module {
	const module = parse(name);
	module.setFeatures(
		binaryen.Features.Atomics |
			binaryen.Features.MutableGlobals |
			binaryen.Features.ExceptionHandling
	);
	const dir = mkdtempSync(join(tmpdir(), 'gmux-evac-'));
	writeFileSync(join(dir, 'in.wasm'), module.emitBinary());
	module.dispose();
	const script = new URL('../../experiments/evacuation/scripts/evacuate.ts', import.meta.url);
	execFileSync(process.execPath, [
		script.pathname,
		join(dir, 'in.wasm'),
		join(dir, 'out.wasm'),
		'--resume',
		'--as-written'
	]);
	return new WebAssembly.Module(readFileSync(join(dir, 'out.wasm')));
}

/** a machine on a clock that moves only when the pump sleeps */
function rig(options: Partial<MachineOptions> = {}) {
	const clock = { ns: 0n };
	let output = '';
	const machineOptions: MachineOptions = {
		vmlinux: toyKernel(!!options.asyncify),
		initrd: new Uint8Array(16),
		cmdline: 'toy',
		registry: new Map(),
		maximumPages: 64,
		// the toy kernel marks each executable with a one-byte name
		sha256: (bytes) => String.fromCharCode(bytes[0] ?? 0),
		now: () => clock.ns,
		write: (text) => (output += text),
		runtime: RUNTIME,
		...options
	};
	const sleep = async (ms: number) => {
		clock.ns += BigInt(Math.max(ms, 1)) * 1_000_000n;
	};
	const run = (machine: Machine, until: () => boolean) => machine.run(until, sleep, 20_000);
	return { clock, machineOptions, run, output: () => output };
}

describe('Machine', () => {
	for (const sharedKernel of [false, true]) {
		describe(
			sharedKernel ? 'one kernel instance for every task' : 'an instance per task',
			() => {
				it('boots, forks, and keeps each task its own globals across switches', async () => {
					const r = rig({ sharedKernel });
					const machine = new Machine(r.machineOptions);
					await r.run(machine, () => r.output().includes('parent ok'));
					expect(r.output()).toBe('boot\nchild\nparent ok\n');
					machine.type('s');
					await r.run(machine, () => r.output().includes('parent back ok'));
					expect(r.output()).toContain('echo:schild ok\nparent back ok\n');
					expect(r.output()).not.toContain('bad');
					expect(machine.stats.instances).toBe(sharedKernel ? 1 : 2);
				});

				it('halts on request', async () => {
					const r = rig({ sharedKernel });
					const machine = new Machine(r.machineOptions);
					await r.run(machine, () => r.output().includes('parent ok'));
					machine.type('q');
					expect(await r.run(machine, () => false)).toBe('halted');
				});
			}
		);
	}

	it("keeps kernel time moving when the host clock stands still, as a deployed Worker's does", async () => {
		const r = rig();
		const frozen: MachineOptions = { ...r.machineOptions, now: () => 0n };
		const machine = new Machine(frozen);
		const sleep = async () => {};
		await machine.run(() => r.output().includes('parent ok'), sleep, 20_000);
		machine.type('x');
		await machine.run(() => r.output().includes('echo:x'), sleep, 20_000);
		expect(r.output()).toContain('echo:x');
	});

	it('reaches an idle deadline in one wait when the host clock stands still', async () => {
		const r = rig();
		let waits = 0;
		const machine = new Machine({ ...r.machineOptions, now: () => 0n });
		const sleep = async () => {
			waits++;
		};
		await machine.run(() => r.output().includes('parent ok'), sleep, 20_000);
		waits = 0;
		machine.type('x');
		await machine.run(() => r.output().includes('echo:x'), sleep, 20_000);
		expect(r.output()).toContain('echo:x');
		// the toy polls its console on a 1 ms deadline: stepping 50 us at a time would take 20 waits
		expect(waits).toBeLessThanOrEqual(2);
	});

	it('never waits 0 ms for a timer that is still ahead, so the host can count the time skipped', async () => {
		const r = rig();
		const machine = new Machine({ ...r.machineOptions, now: () => 0n });
		const seen: number[] = [];
		const sleep = async (ms: number) => void seen.push(ms);
		await machine.run(() => r.output().includes('parent ok'), sleep, 20_000);
		seen.length = 0;
		machine.type('x');
		await machine.run(() => r.output().includes('echo:x'), sleep, 20_000);
		// the pump's own yield every yieldEvery steps is the only 0
		expect(seen.filter((ms) => ms > 0).length).toBeGreaterThan(0);
		expect(seen.every((ms) => Number.isInteger(ms))).toBe(true);
	});

	it('moves a standing clock by the time the kernel charges, and not by reading it', async () => {
		const r = rig();
		const machine = new Machine({ ...r.machineOptions, now: () => 0n });
		const sleep = async () => {};
		await machine.run(() => r.output().includes('parent ok'), sleep, 20_000);
		machine.type('c');
		await machine.run(() => r.output().includes('clock'), sleep, 20_000);
		expect(r.output()).toContain('clock moves');
	});

	it('raises the console interrupt on the interrupt cpu when input arrives, instead of waiting for a poll', async () => {
		const r = rig({ sharedKernel: true });
		const machine = new Machine(r.machineOptions);
		await r.run(machine, () => r.output().includes('parent ok'));
		machine.type('k');
		await r.run(machine, () => r.output().includes('echo:k'));
		await r.run(machine, () => false);
		expect(machine.stats.consoleRaises).toBe(0);
		machine.type('z');
		await r.run(machine, () => r.output().includes('console irq'));
		expect(r.output()).toContain('console irq');
		expect(machine.stats.consoleRaises).toBe(1);
	});

	it('keeps input typed before the first run for the console to read once the kernel is up', async () => {
		const r = rig({ sharedKernel: true });
		const machine = new Machine(r.machineOptions);
		machine.type('k');
		await r.run(machine, () => r.output().includes('echo:k'));
		expect(r.output()).toContain('echo:k');
		expect(machine.crashed).toBeNull();
	});

	describe('console ring', () => {
		// the kernel's three puts while it boots
		const BOOT = 'boot\nchild\nparent ok\n';
		const words = (m: Machine) => new Uint32Array(m.memory.buffer, 0x1e000, 4);
		const bytes = (m: Machine) => new Uint8Array(m.memory.buffer, 0x1e010, 0x400);
		const boot = async (options: Partial<MachineOptions> = {}) => {
			const r = rig(options);
			const machine = new Machine(r.machineOptions);
			await r.run(machine, () => r.output().includes('parent ok'));
			return { r, machine };
		};

		it('takes the kernel puts into the ring and writes them from the host without a put call', async () => {
			const { r, machine } = await boot();
			expect(r.output()).toBe(BOOT);
			expect(machine.stats.consolePuts).toBe(0);
			expect(machine.stats.consoleDrains).toBeGreaterThan(0);
			expect(machine.stats.consoleDrainBytes).toBe(BOOT.length);
			expect(words(machine)[2]).toBe(1);
		});

		it('writes the same bytes with the ring off, one put each', async () => {
			const on = await boot();
			const off = await boot({ consoleRing: false });
			expect(off.r.output()).toBe(on.r.output());
			expect(off.machine.stats.consolePuts).toBe(3);
			expect(off.machine.stats.consoleDrains).toBe(0);
			expect(words(off.machine)[2]).toBe(0);
		});

		it('counts head and tail in bytes, and leaves the ring empty after every run', async () => {
			const { r, machine } = await boot();
			expect(words(machine)[0]).toBe(BOOT.length);
			expect(words(machine)[1]).toBe(BOOT.length);
			machine.type('k');
			await r.run(machine, () => r.output().includes('echo:k'));
			expect(words(machine)[0]).toBe(BOOT.length + 6);
			expect(words(machine)[1]).toBe(BOOT.length + 6);
		});

		it('sends a put that does not fit to the host after the queued bytes, and queues the next', async () => {
			const { r, machine } = await boot();
			const start = r.output().length;
			machine.type('g');
			await r.run(machine, () => r.output().includes('C'.repeat(600)));
			expect(r.output().slice(start)).toBe(
				`echo:g${'A'.repeat(600)}${'B'.repeat(600)}${'C'.repeat(600)}`
			);
			expect(machine.stats.consolePuts).toBe(1);
			expect(machine.stats.consolePutBytes).toBe(600);
			expect(machine.stats.consoleDrainPeak).toBeGreaterThanOrEqual(606);
		});

		it('wraps a put around the end of the ring', async () => {
			const r = rig();
			const machine = new Machine(r.machineOptions);
			words(machine)[0] = 1020;
			words(machine)[1] = 1020;
			await r.run(machine, () => r.output().includes('parent ok'));
			expect(r.output()).toBe(BOOT);
			expect(words(machine)[0]).toBe(1020 + BOOT.length);
			expect(words(machine)[1]).toBe(1020 + BOOT.length);
			expect(bytes(machine)[0]).toBe('\n'.charCodeAt(0));
		});

		it('drains what the kernel queued when run returns, even for a step that ended the run', async () => {
			const { r, machine } = await boot();
			machine.type('k');
			expect(await r.run(machine, () => r.output().includes('echo:k'))).toBe('until');
			expect(words(machine)[0]).toBe(words(machine)[1]);
		});

		it('writes the queued bytes before it halts', async () => {
			const { r, machine } = await boot();
			machine.type('q');
			expect(await r.run(machine, () => false)).toBe('halted');
			expect(r.output()).toBe(`${BOOT}echo:q`);
		});

		it('keeps the output queued before a panic', async () => {
			const { r, machine } = await boot();
			machine.type('e');
			await r.run(machine, () => r.output().includes('before panic'));
			expect(r.output()).toBe(`${BOOT}echo:ebefore panic\n`);
			expect(words(machine)[0]).toBe(words(machine)[1]);
		});

		it('drains before a checkpoint, so a restore neither loses nor repeats a byte', async () => {
			const { r, machine } = await boot({ asyncify: true });
			const text = 'queued just before the checkpoint\n';
			const ring = words(machine);
			bytes(machine).set(new TextEncoder().encode(text), ring[0]! & 0x3ff);
			ring[0] = ring[0]! + text.length;
			const snapshot = await machine.checkpoint();
			expect(r.output()).toBe(`${BOOT}${text}`);
			const view = new DataView(snapshot.memory.buffer, snapshot.memory.byteOffset);
			expect(view.getUint32(0x1e000, true)).toBe(view.getUint32(0x1e004, true));
			const restored = await Machine.restore(r.machineOptions, snapshot);
			restored.type('s');
			await r.run(restored, () => r.output().includes('parent back ok'));
			expect(r.output()).toBe(`${BOOT}${text}echo:schild ok\nparent back ok\n`);
		});

		it('turns the ring off on a restore into a machine that asks for none', async () => {
			const { r, machine } = await boot({ asyncify: true });
			const snapshot = await machine.checkpoint();
			const restored = await Machine.restore(
				{ ...r.machineOptions, consoleRing: false },
				snapshot
			);
			restored.type('k');
			await r.run(restored, () => r.output().includes('echo:k'));
			expect(words(restored)[2]).toBe(0);
			expect(restored.stats.consolePuts).toBe(snapshot.stats.consolePuts + 2);
			expect(restored.stats.consoleDrains).toBe(snapshot.stats.consoleDrains);
		});
	});

	it('delivers a signal whose handler blocks, to a program that links no clone code', async () => {
		const r = rig({ sharedKernel: true, registry: new Map([['U', toyUser()]]) });
		const machine = new Machine(r.machineOptions);
		await r.run(machine, () => r.output().includes('parent ok'));
		machine.type('u');
		await r.run(machine, () => r.output().includes('handled'));
		machine.type('r');
		await r.run(machine, () => r.output().includes('user back'));
		expect(r.output()).toContain('handled\necho:ruser back\n');
		expect(machine.stats.signals).toBe(1);
	});

	it('runs a vfork child on the parent stack, then hands it back with the pid after execve', async () => {
		const registry = new Map([
			['U', toyUser()],
			['V', toyUser('toy-vfork.wat')]
		]);
		const r = rig({ sharedKernel: true, registry });
		const machine = new Machine(r.machineOptions);
		await r.run(machine, () => r.output().includes('parent ok'));
		machine.type('v');
		await r.run(machine, () => r.output().includes('handled'));
		machine.type('r');
		await r.run(machine, () => r.output().includes('user back'));
		expect(r.output()).toContain('vfork child\nvfork parent\nhandled\necho:ruser back\n');
		expect(r.output()).not.toContain('vfork bad');
	});

	for (const shareInstances of [true, false]) {
		it(`runs two processes of a program ${shareInstances ? 'on one instance' : 'on an instance each'}, each keeping its own base, globals and data`, async () => {
			const r = rig({
				sharedKernel: true,
				shareInstances,
				registry: new Map([['S', toyShared()]])
			});
			const machine = new Machine(r.machineOptions);
			await r.run(machine, () => r.output().includes('parent ok'));
			machine.type('w');
			await r.run(machine, () => (r.output().match(/shared (ok|bad)/g) ?? []).length === 2);
			expect(r.output()).toContain('shared ok\nshared ok\n');
			expect(r.output()).not.toContain('shared bad');
			expect(machine.stats.userExecs).toBe(shareInstances ? 1 : 2);
			expect(machine.stats.sharedEntries).toBe(shareInstances ? 1 : 0);
			if (shareInstances)
				await expect(machine.checkpoint()).rejects.toThrow(/shared program instances/);
		});
	}

	describe('recycled instances', () => {
		const setup = (options: Partial<MachineOptions> = {}) => {
			const r = rig({
				sharedKernel: true,
				registry: new Map([['S', toyShared()]]),
				...options
			});
			const machine = new Machine(r.machineOptions);
			let echoes = 0;
			// the kernel releases the task at 0x854 when input next arrives; its stack unwinds in a few ticks
			const release = async (id: number, on = machine) => {
				new DataView(on.memory.buffer).setUint32(0x854, id, true);
				on.type(' ');
				echoes++;
				await r.run(on, () => (r.output().match(/echo: /g) ?? []).length === echoes);
				await new Promise((done) => setTimeout(done, 5));
			};
			const spawn = async (key: string, total: number, on = machine) => {
				on.type(key);
				await r.run(
					on,
					() => (r.output().match(/shared (ok|bad)/g) ?? []).length === total
				);
			};
			return { r, machine, release, spawn };
		};

		for (const size of [8, 0]) {
			it(`${size ? 'hands a finished process its instance again' : 'instantiates every exec when the pool is off'}, with the same transcript`, async () => {
				const { r, machine, release, spawn } = setup({ recycleInstances: size });
				await r.run(machine, () => r.output().includes('parent ok'));
				await spawn('w', 2);
				await release(3);
				await release(5);
				await spawn('w', 4);
				expect(r.output().match(/shared ok\n/g)).toHaveLength(4);
				expect(r.output()).not.toContain('shared bad');
				expect(machine.stats.userExecs).toBe(size ? 2 : 4);
				expect(machine.stats.recycledStarts).toBe(size ? 2 : 0);
				expect(machine.stats.recycleReturns).toBe(size ? 2 : 0);
			});
		}

		it('keeps no more idle instances than the pool size', async () => {
			const { r, machine, release, spawn } = setup({ recycleInstances: 1 });
			await r.run(machine, () => r.output().includes('parent ok'));
			await spawn('w', 2);
			await release(3);
			await release(5);
			await spawn('w', 4);
			expect(machine.stats.recycleReturns).toBe(1);
			expect(machine.stats.recycledStarts).toBe(1);
			expect(machine.stats.userExecs).toBe(3);
			expect(r.output()).not.toContain('shared bad');
		});

		it('leaves an instance made for another table start in the pool and instantiates', async () => {
			const { r, machine, release, spawn } = setup();
			await r.run(machine, () => r.output().includes('parent ok'));
			await spawn('p', 1);
			await release(3);
			await spawn('w', 3);
			expect(machine.stats.recycledStarts).toBe(0);
			expect(machine.stats.userExecs).toBe(3);
			expect(r.output()).not.toContain('shared bad');
		});

		it('copies the pristine data image to an exec and leaves a clone, which shares live data, alone, each on an instance of its own kind', async () => {
			const { r, machine, release, spawn } = setup();
			await r.run(machine, () => r.output().includes('parent ok'));
			await spawn('w', 2);
			await release(3);
			await release(5);
			const bytes = new Uint8Array(machine.memory.buffer);
			const enter = (clone: boolean) => {
				const runner = (machine as any).runner('t', { kind: 'secondary', idle: 0 });
				runner.instance = (machine as any).shared;
				runner.user = {
					module: (machine as any).options.registry.get('S'),
					hash: 'S',
					dataStart: 0x10000,
					tableStart: 0
				};
				(machine as any).enterProgram(runner, clone);
				return runner;
			};
			bytes.fill(0xaa, 0x10000, 0x10010);
			// a clone starts on an instance of its own kind: none is idle yet, so this one is new
			const first = enter(true);
			expect(first.recycled.clone).toBe(true);
			expect(machine.stats.recycledStarts).toBe(0);
			expect(bytes.subarray(0x10000, 0x10010)).toEqual(new Uint8Array(16).fill(0xaa));
			const clones = first.recycled;
			(machine as any).retire(first);
			// an exec takes one of the two exec instances, never the clone's, and gets the pristine image
			const exec = enter(false);
			expect(exec.recycled.clone).toBe(false);
			expect(machine.stats.recycledStarts).toBe(1);
			// the image the first process started from, then toy-shared's data relocation of it
			expect(bytes[0x10000]).toBe(0);
			expect(new DataView(machine.memory.buffer).getUint32(0x10004, true)).toBe(0x10000);
			// and the next clone takes the clone's, leaving the live data alone
			bytes.fill(0xaa, 0x10000, 0x10010);
			const again = enter(true);
			expect(again.recycled).toBe(clones);
			expect(machine.stats.recycledStarts).toBe(2);
			expect(bytes.subarray(0x10000, 0x10010)).toEqual(new Uint8Array(16).fill(0xaa));
		});

		it("never gives a process on a fork child's own memory a pooled instance", async () => {
			const { r, machine, release, spawn } = setup();
			await r.run(machine, () => r.output().includes('parent ok'));
			await spawn('w', 2);
			await release(3);
			await release(5);
			(machine as any).privateMemories.set(
				1,
				new WebAssembly.Memory({ initial: 2, maximum: 64, shared: true })
			);
			await spawn('w', 4);
			expect(machine.stats.recycledStarts).toBe(0);
			expect(machine.stats.userExecs).toBe(4);
		});

		it('checkpoints with idle instances pooled, saves none, and refills after a restore', async () => {
			const { r, machine, release, spawn } = setup({ asyncify: true });
			await r.run(machine, () => r.output().includes('parent ok'));
			await spawn('w', 2);
			await release(3);
			await release(5);
			expect(machine.stats.recycleReturns).toBe(2);
			const snapshot = await machine.checkpoint();
			const restored = await Machine.restore(r.machineOptions, snapshot);
			await spawn('w', 4, restored);
			// the pool did not travel: both processes instantiated, then went back to it
			expect(restored.stats.userExecs).toBe(4);
			expect(restored.stats.recycledStarts).toBe(0);
			await release(3, restored);
			await release(5, restored);
			expect(restored.stats.recycleReturns).toBe(4);
			await spawn('w', 6, restored);
			expect(restored.stats.recycledStarts).toBe(2);
			expect(r.output()).not.toContain('shared bad');
		});

		it('leaves a program that is not a share build to its own instance each time', async () => {
			const r = rig({ sharedKernel: true, registry: new Map([['U', toyUser()]]) });
			const machine = new Machine(r.machineOptions);
			await r.run(machine, () => r.output().includes('parent ok'));
			machine.type('u');
			await r.run(machine, () => r.output().includes('user back'));
			expect(machine.stats.recycledStarts).toBe(0);
			expect(machine.stats.recycleReturns).toBe(0);
		});
	});

	it('kills a task whose code traps with the signal Linux sends, and keeps the machine running', async () => {
		const r = rig({ sharedKernel: true, registry: new Map([['F', toyUser('toy-fault.wat')]]) });
		const machine = new Machine(r.machineOptions);
		await r.run(machine, () => r.output().includes('parent ok'));
		machine.type('f');
		await r.run(machine, () => r.output().includes('fatal signal'));
		const view = new DataView(machine.memory.buffer);
		// SIGILL for unreachable, unblocked first
		expect(view.getUint32(0x800, true)).toBe(4);
		expect(view.getUint32(0x804, true)).toBe(1 << 3);
		machine.type('s');
		expect(await r.run(machine, () => r.output().includes('parent back ok'))).not.toBe(
			'crashed'
		);
		expect(machine.crashed).toBeNull();
	});

	it('ends a task whose stack overflows with SIGSEGV, first undoing a syscall the trap unwound', async () => {
		const logs: string[] = [];
		const r = rig({
			sharedKernel: true,
			registry: new Map([['O', toyUser('toy-overflow.wat')]]),
			log: (line) => logs.push(line)
		});
		const machine = new Machine(r.machineOptions);
		await r.run(machine, () => r.output().includes('parent ok'));
		new DataView(machine.memory.buffer).setUint32(0x810, 1, true);
		machine.type('o');
		await r.run(machine, () => r.output().includes('fatal signal'));
		expect(new DataView(machine.memory.buffer).getUint32(0x800, true)).toBe(11);
		expect(logs.some((line) => line.includes('unwound a syscall'))).toBe(true);
		expect(machine.crashed).toBeNull();
	});

	it('lets the interrupt run at a yield park its cpu, as a kernel entry of its own', async () => {
		const r = rig({ sharedKernel: true, registry: new Map([['I', toyUser('toy-spin.wat')]]) });
		const machine = new Machine(r.machineOptions);
		await r.run(machine, () => r.output().includes('parent ok'));
		machine.type('i');
		await r.run(machine, () => machine.stats.fuelYields > 3);
		const view = new DataView(machine.memory.buffer);
		view.setUint32(0x814, 1, true);
		view.setUint32(0x80c, 1, true);
		await r.run(machine, () => machine.stats.fuelYields > 10);
		expect(machine.crashed).toBeFalsy();
		expect(r.output().match(/user interrupt/g)).toHaveLength(1);
	});

	it('passes a spinning task through the kernel at its next yield when work waits for it', async () => {
		const r = rig({ sharedKernel: true, registry: new Map([['I', toyUser('toy-spin.wat')]]) });
		const machine = new Machine(r.machineOptions);
		await r.run(machine, () => r.output().includes('parent ok'));
		machine.type('i');
		await r.run(machine, () => machine.stats.fuelYields > 3);
		expect(r.output()).not.toContain('user interrupt');
		new DataView(machine.memory.buffer).setUint32(0x80c, 1, true);
		await r.run(machine, () => machine.stats.fuelYields > 10);
		expect(r.output().match(/user interrupt/g)).toHaveLength(1);
	});

	it("parks a program on an absent page until it is brought in, and asks for its start function's pages without waiting", async () => {
		const asked: [number, boolean][] = [];
		const r = rig({
			sharedKernel: true,
			registry: new Map([['M', toyUser('toy-mmu.wat')]]),
			pageIn: (page, canWait) => {
				asked.push([page, canWait]);
				if (page !== 10) return undefined;
				// brought in after the program has parked: the word only exists once the page is in
				return new Promise<void>((resolve) =>
					setTimeout(() => {
						new DataView(machine.memory.buffer).setUint32(0xa000, 0x1234abcd, true);
						resolve();
					}, 0)
				);
			}
		});
		const machine = new Machine(r.machineOptions);
		await r.run(machine, () => r.output().includes('parent ok'));
		machine.type('m');
		await r.run(machine, () => r.output().includes('user back'));
		expect(asked).toEqual([
			[9, false],
			[10, true]
		]);
		expect(new DataView(machine.memory.buffer).getUint32(0x830, true)).toBe(0x1234abcd);
		expect(machine.stats.pageFaults).toBe(1);
	});

	it("sizes its memory from the kernel's gmux.memory note", () => {
		const bytes = new Uint8Array(parse('toy-kernel.wat').emitBinary());
		// a custom section: id 0, size, name "gmux.memory", u32 pages = 20
		const name = new TextEncoder().encode('gmux.memory');
		const section = new Uint8Array([0, 1 + name.length + 4, name.length, ...name, 20, 0, 0, 0]);
		const noted = new Uint8Array([...bytes, ...section]);
		const r = rig({ vmlinux: new WebAssembly.Module(noted) });
		expect(new Machine(r.machineOptions).memory.buffer.byteLength).toBe(20 * 0x10000);
		expect(new Machine(rig().machineOptions).memory.buffer.byteLength).toBe(15 * 0x10000);
	});

	it("boots into a dead machine's memory, zeroed, instead of allocating a second one", async () => {
		const dead = new WebAssembly.Memory({ initial: 15, maximum: 64, shared: true });
		new Uint8Array(dead.buffer).fill(0xa5);
		const r = rig({ sharedKernel: true, memory: dead });
		const machine = new Machine(r.machineOptions);
		expect(machine.memory).toBe(dead);
		expect(new Uint8Array(machine.memory.buffer).every((b) => b === 0)).toBe(true);
		await r.run(machine, () => r.output().includes('parent ok'));
		machine.type('s');
		await r.run(machine, () => r.output().includes('parent back ok'));
		expect(r.output()).toBe('boot\nchild\nparent ok\necho:schild ok\nparent back ok\n');
	});

	it('declines a memory larger than it starts with, since the kernel takes the rest as RAM', () => {
		const grown = new WebAssembly.Memory({ initial: 40, maximum: 64, shared: true });
		const machine = new Machine(rig({ memory: grown }).machineOptions);
		expect(machine.memory).not.toBe(grown);
		expect(machine.memory.buffer.byteLength).toBe(15 * 0x10000);
	});

	it('refuses a program that imports anything outside the syscall surface', async () => {
		const reach = new WebAssembly.Module(parse('toy-reach.wat').emitBinary());
		const r = rig({ sharedKernel: true, registry: new Map([['U', reach]]) });
		const machine = new Machine(r.machineOptions);
		await r.run(machine, () => r.output().includes('parent ok'));
		machine.type('u');
		expect(await r.run(machine, () => false)).toBe('crashed');
		expect(String(machine.crashed)).toMatch(/LinkError.*fetch/);
	});

	it('refuses to load an executable it holds no build of, and keeps the machine running', async () => {
		const r = rig({ sharedKernel: true, registry: new Map([['U', toyUser()]]) });
		const machine = new Machine(r.machineOptions);
		await r.run(machine, () => r.output().includes('parent ok'));
		machine.type('x');
		await r.run(machine, () => /exec (refused|taken)/.test(r.output()));
		expect(r.output()).toContain('exec refused\n');
		expect(machine.stats.unknownExecutables).toEqual(['X (4 bytes)']);
		machine.type('s');
		await r.run(machine, () => r.output().includes('parent back ok'));
		expect(machine.crashed).toBeNull();
	});

	describe('a recorded dlopen miss', () => {
		const exec = async (options: Partial<MachineOptions>) => {
			const r = rig({
				sharedKernel: true,
				registry: new Map([['U', toyUser()]]),
				...options
			});
			const machine = new Machine(r.machineOptions);
			await r.run(machine, () => r.output().includes('parent ok'));
			machine.type('u');
			const end = await r.run(machine, () => r.output().includes('handled'));
			return { machine, end };
		};

		it('starts the next run of that executable on the interpreted tier', async () => {
			const asked: [string, string[]][] = [];
			const reach = new WebAssembly.Module(parse('toy-reach.wat').emitBinary());
			const { machine } = await exec({
				dlMisses: new Map([['U', new Set(['L'])]]),
				interpret: (exe, libs) => {
					asked.push([exe, libs]);
					return reach;
				}
			});
			expect(asked).toEqual([['U', ['L']]]);
			expect(machine.stats.interpretedStarts).toEqual(['U']);
			expect(String(machine.crashed)).toMatch(/LinkError.*fetch/);
		});

		it('leaves an executable with no miss, and one the tier cannot take, on the registry build', async () => {
			let asked = 0;
			const clean = await exec({
				interpret: () => {
					asked++;
					return undefined;
				}
			});
			expect(asked).toBe(0);
			expect(clean.machine.stats.interpretedStarts).toEqual([]);
			const refused = await exec({
				dlMisses: new Map([['U', new Set(['L'])]]),
				interpret: () => {
					asked++;
					return undefined;
				}
			});
			expect(asked).toBe(1);
			expect(refused.machine.stats.interpretedStarts).toEqual([]);
			expect(refused.machine.crashed).toBeNull();
			const none = await exec({ dlMisses: new Map([['U', new Set(['L'])]]) });
			expect(none.machine.stats.interpretedStarts).toEqual([]);
		});
	});

	describe('an exec whose module outgrows its stub', () => {
		// a program whose dylink.0 names `memory` bytes of data, as an exec stub the kernel hands over
		function stubOf(memory: number, tag: number): Uint8Array {
			const info = [...uleb(memory), 2, 3, 0];
			const name = [8, ...Buffer.from('dylink.0')];
			const body = [...name, 1, info.length, ...info];
			const program = new Uint8Array([
				0,
				0x61,
				0x73,
				0x6d,
				1,
				0,
				0,
				0,
				0,
				...uleb(body.length),
				...body,
				// a data section distinguishes the programs by hash
				11,
				3,
				1,
				0,
				tag
			]);
			return stub(program)!;
		}

		function lookup(stubbed: Uint8Array, module: WebAssembly.Module) {
			const r = rig({ registry: new Map([[stubHash(stubbed)!, module]]) });
			const machine = new Machine(r.machineOptions);
			const at = 0x20000;
			new Uint8Array(machine.memory.buffer).set(stubbed, at);
			const found = (machine as any).lookup(null, at, at + stubbed.length, 0x10000, 0);
			return { found, machine };
		}

		it('refuses a module of 32,992 bytes under a stub that maps 31,664', () => {
			const { found, machine } = lookup(
				stubOf(31664, 1),
				toyUser('toy-user.wat', false, 32992)
			);
			expect(found).toBeUndefined();
			expect(machine.stats.unknownExecutables).toHaveLength(1);
			expect(machine.stats.unknownExecutables[0]).toMatch(
				/needs 32992 bytes of data, stub maps 31664/
			);
		});

		it('runs a module its stub maps, the stub rounded up to whole pages', () => {
			for (const [stubbed, data] of [
				[31664, 31664],
				[31664, 32768],
				[32992, 32992]
			] as const) {
				const { found, machine } = lookup(
					stubOf(stubbed, 2),
					toyUser('toy-user.wat', false, data)
				);
				expect(found).toBeDefined();
				expect(machine.stats.unknownExecutables).toEqual([]);
			}
		});

		it('runs a module with no note, as an older build has none', () => {
			expect(lookup(stubOf(100, 3), toyUser()).found).toBeDefined();
		});
	});

	it("gives each machine its own memory, which another machine's tasks cannot reach", async () => {
		const [a, b] = [rig({ sharedKernel: true }), rig({ sharedKernel: true })];
		const [one, two] = [new Machine(a.machineOptions), new Machine(b.machineOptions)];
		await a.run(one, () => a.output().includes('parent ok'));
		await b.run(two, () => b.output().includes('parent ok'));
		expect(one.memory).not.toBe(two.memory);
		new DataView(one.memory.buffer).setUint32(0x81c, 0xdeadbeef, true);
		expect(new DataView(two.memory.buffer).getUint32(0x81c, true)).toBe(0);
		one.type('s');
		two.type('q');
		await a.run(one, () => a.output().includes('parent back ok'));
		await b.run(two, () => two.halted);
		expect(one.halted).toBe(false);
		expect(one.crashed).toBeNull();
	});

	it('refuses a non-root exec of a program with no guarded build', async () => {
		const r = rig({
			sharedKernel: true,
			registry: new Map([['X', toyUser()]]),
			guarded: new Map()
		});
		const machine = new Machine(r.machineOptions);
		await r.run(machine, () => r.output().includes('parent ok'));
		new DataView(machine.memory.buffer).setUint32(0x81c, 1000, true);
		machine.type('x');
		await r.run(machine, () => /exec (refused|taken)/.test(r.output()));
		expect(r.output()).toContain('exec refused\n');
		expect(machine.stats.unknownExecutables).toEqual(['X (4 bytes, no guarded build)']);
		expect(machine.crashed).toBeNull();
	});

	describe('checkpoint and restore', () => {
		async function checkpointed(
			beforeCheckpoint: (r: ReturnType<typeof rig>) => void = () => {}
		) {
			const r = rig({ asyncify: true });
			const machine = new Machine(r.machineOptions);
			await r.run(machine, () => r.output().includes('parent ok'));
			beforeCheckpoint(r);
			const snapshot = await machine.checkpoint();
			const restored = await Machine.restore(r.machineOptions, snapshot);
			return { r, machine, snapshot, restored };
		}

		it('continues every task exactly in fresh instances', async () => {
			const { r, restored, snapshot } = await checkpointed();
			expect(snapshot.runners.filter((s) => s.kernelStack)).toHaveLength(2);
			restored.type('s');
			await r.run(restored, () => r.output().includes('parent back ok'));
			expect(r.output()).toContain('echo:schild ok\nparent back ok\n');
			expect(r.output()).not.toContain('bad');
			restored.type('q');
			expect(await r.run(restored, () => false)).toBe('halted');
		});

		it('leaves memory as the snapshot recorded it until the machine runs again, but for the reseed', async () => {
			const { restored, snapshot } = await checkpointed();
			const now = new Uint8Array(restored.memory.buffer);
			const [from, to] = [snapshot.scratch, snapshot.scratch + 32 * 0x10000];
			const reseed = (i: number) => i >= 0x1200 && i < 0x1220;
			let changed = 0;
			for (let i = 0; i < snapshot.memory.byteLength; i++)
				if ((i < from || i >= to) && !reseed(i) && now[i] !== snapshot.memory[i]) changed++;
			expect(changed).toBe(0);
		});

		it('restores through a lazy reader with no process pages to defer', async () => {
			const r = rig({ asyncify: true });
			const machine = new Machine(r.machineOptions);
			await r.run(machine, () => r.output().includes('parent ok'));
			const snapshot = await machine.checkpoint();
			const saved = snapshot.memory.slice();
			const restored = await Machine.restore(
				r.machineOptions,
				{ ...snapshot, memory: new Uint8Array(0), owners: undefined },
				undefined,
				{ byteLength: saved.byteLength, read: (s, e) => saved.slice(s, e) }
			);
			// the toy runs on zeroed memory too (its data segments), so the bytes are the check
			const now = new Uint8Array(restored.memory.buffer);
			const [from, to] = [snapshot.scratch, snapshot.scratch + 32 * 0x10000];
			let changed = 0;
			for (let i = 0; i < saved.byteLength; i++)
				if ((i < from || i >= to) && (i < 0x1200 || i >= 0x1220) && now[i] !== saved[i])
					changed++;
			expect(changed).toBe(0);
			restored.type('s');
			await r.run(restored, () => r.output().includes('parent back ok'));
			expect(r.output()).not.toContain('bad');
		});

		it('rekeys the kernel random numbers of every restored copy, and not on a resume', async () => {
			const r = rig({ asyncify: true });
			const machine = new Machine(r.machineOptions);
			await r.run(machine, () => r.output().includes('parent ok'));
			const snapshot = await machine.checkpoint();
			const copy = () => ({ ...snapshot, memory: snapshot.memory.slice() });
			const key = (m: Machine) =>
				new Uint8Array(m.memory.buffer).slice(0x1200, 0x1220).join();
			const a = await Machine.restore(r.machineOptions, copy());
			const b = await Machine.restore(r.machineOptions, copy());
			expect([a.stats.restoreHooks, b.stats.restoreHooks]).toEqual([1, 1]);
			expect(key(a)).not.toBe(key(b));
			expect(key(a)).not.toBe(snapshot.memory.slice(0x1200, 0x1220).join());
			const again = await a.checkpoint();
			const before = key(a);
			const resumed = await Machine.resume({ ...r.machineOptions, memory: a.memory }, again);
			expect(resumed.stats.restoreHooks).toBe(1);
			expect(key(resumed)).toBe(before);
		});

		it('zeroes the pages the kernel reports free, within its frame count', async () => {
			const r = rig({ asyncify: true });
			const machine = new Machine(r.machineOptions);
			await r.run(machine, () => r.output().includes('parent ok'));
			const bytes = new Uint8Array(machine.memory.buffer);
			bytes.set(new TextEncoder().encode('free page'), 120 * 0x1000);
			bytes.set(new TextEncoder().encode('past count'), 200 * 0x1000);
			const snapshot = await machine.checkpoint();
			const page = (n: number) => snapshot.memory.subarray(n * 0x1000, (n + 1) * 0x1000);
			expect(page(120).every((b) => b === 0)).toBe(true);
			expect(new TextDecoder().decode(page(200).subarray(0, 10))).toBe('past count');
			expect(snapshot.stats.freePages).toBe(1);
		});

		it("restores into its own predecessor's memory", async () => {
			const r = rig({ asyncify: true });
			const machine = new Machine(r.machineOptions);
			await r.run(machine, () => r.output().includes('parent ok'));
			const snapshot = await machine.checkpoint();
			const saved = { ...snapshot, memory: snapshot.memory.slice() };
			const restored = await Machine.restore(
				{ ...r.machineOptions, memory: machine.memory },
				saved
			);
			expect(restored.memory).toBe(machine.memory);
			restored.type('s');
			await r.run(restored, () => r.output().includes('parent back ok'));
			expect(r.output()).not.toContain('bad');
			restored.type('q');
			expect(await r.run(restored, () => false)).toBe('halted');
		});

		it('restores from an image written straight into its memory', async () => {
			const r = rig({ asyncify: true });
			const machine = new Machine(r.machineOptions);
			await r.run(machine, () => r.output().includes('parent ok'));
			const snapshot = await machine.checkpoint();
			const saved = snapshot.memory.slice();
			const image = {
				byteLength: saved.byteLength,
				write: (into: Uint8Array) => into.set(saved)
			};
			const restored = await Machine.restore(
				r.machineOptions,
				{ ...snapshot, memory: new Uint8Array(0) },
				image
			);
			restored.type('s');
			await r.run(restored, () => r.output().includes('parent back ok'));
			expect(r.output()).not.toContain('bad');
		});

		it('evacuates a program parked in the kernel and resumes it without asyncify', async () => {
			const r = rig({
				asyncify: true,
				sharedKernel: true,
				registry: new Map([['I', evacuated('toy-evac.wat')]])
			});
			const machine = new Machine(r.machineOptions);
			await r.run(machine, () => r.output().includes('parent ok'));
			machine.type('i');
			await r.run(machine, () => machine.stats.fuelYields >= 40);
			await r.run(machine, () => false);
			const snapshot = await machine.checkpoint();
			const user = snapshot.runners.find((s) => s.program);
			expect(user?.userStack?.byteLength).toBeGreaterThan(0);
			const saved = { ...snapshot, memory: snapshot.memory.slice() };
			const restored = await Machine.restore(r.machineOptions, saved);
			const before = r.output().length;
			restored.type('r');
			await r.run(restored, () => r.output().includes('user back'));
			expect(r.output().slice(before)).toContain('handled\nvfork child\nuser back\n');
			expect(restored.crashed).toBeFalsy();
		});

		it('re-enters restored frames in their own instance at a fuel yield', async () => {
			const r = rig({
				asyncify: true,
				sharedKernel: true,
				registry: new Map([['I', evacuated('toy-evac.wat')]])
			});
			const machine = new Machine(r.machineOptions);
			await r.run(machine, () => r.output().includes('parent ok'));
			machine.type('i');
			await r.run(machine, () => machine.stats.fuelYields >= 10);
			const snapshot = await machine.checkpoint();
			expect(snapshot.runners.find((s) => s.program)?.where).toBe('user');
			const saved = { ...snapshot, memory: snapshot.memory.slice() };
			const restored = await Machine.restore(
				{ ...r.machineOptions, reenterAfterRestore: 0 },
				saved
			);
			await r.run(restored, () => restored.stats.reentries > 0);
			// the count's local survived the second spill: the loop still ends at 40
			await r.run(restored, () => false);
			expect(restored.stats.fuelYields - snapshot.stats.fuelYields).toBe(
				40 - snapshot.stats.fuelYields
			);
			const before = r.output().length;
			restored.type('r');
			await r.run(restored, () => r.output().includes('user back'));
			expect(r.output().slice(before)).toContain('handled\nvfork child\nuser back\n');
			expect(restored.stats.reentries).toBe(1);
			expect(restored.crashed).toBeFalsy();
		});

		it('checkpoints a signal handler parked on its own stack, and the frames it interrupted', async () => {
			const r = rig({
				asyncify: true,
				sharedKernel: true,
				registry: new Map([['U', evacuated('toy-user.wat')]])
			});
			const machine = new Machine(r.machineOptions);
			await r.run(machine, () => r.output().includes('parent ok'));
			machine.type('u');
			await r.run(machine, () => r.output().includes('handled'));
			await r.run(machine, () => false);
			const snapshot = await machine.checkpoint();
			const user = snapshot.runners.find((s) => s.program);
			expect(user?.signal?.user.byteLength).toBeGreaterThan(0);
			expect(user?.userStack?.byteLength).toBeGreaterThan(0);
			const restored = await Machine.restore(r.machineOptions, {
				...snapshot,
				memory: snapshot.memory.slice()
			});
			const before = r.output().length;
			restored.type('r');
			await r.run(restored, () => r.output().includes('user back'));
			expect(r.output().slice(before)).toBe('echo:ruser back\n');
			expect(restored.crashed).toBeFalsy();
		});

		it("restores lazily: a parked process's pages come in only when one of its tasks runs", async () => {
			const r = rig({
				asyncify: true,
				sharedKernel: true,
				registry: new Map([['I', evacuated('toy-evac.wat')]])
			});
			const machine = new Machine(r.machineOptions);
			await r.run(machine, () => r.output().includes('parent ok'));
			machine.type('i');
			await r.run(machine, () => machine.stats.fuelYields >= 40);
			await r.run(machine, () => false);
			new Uint8Array(machine.memory.buffer).set([1, 2, 3, 4], 0x10000);
			const snapshot = await machine.checkpoint();
			expect(snapshot.runners.find((s) => s.program)?.tag).toBe(7);
			const saved = snapshot.memory.slice();
			const reads: [number, number][] = [];
			const restored = await Machine.restore(
				r.machineOptions,
				{ ...snapshot, memory: new Uint8Array(0) },
				undefined,
				{
					byteLength: saved.byteLength,
					read: (start, end) => {
						reads.push([start, end]);
						return saved.slice(start, end);
					}
				}
			);
			expect(restored.stats.deferredPages).toBe(1);
			expect([...new Uint8Array(restored.memory.buffer, 0x10000, 4)]).toEqual([0, 0, 0, 0]);
			const before = r.output().length;
			restored.type('r');
			await r.run(restored, () => r.output().includes('user back'));
			expect(r.output().slice(before)).toContain('handled\nvfork child\nuser back\n');
			expect(restored.stats.filledPages).toBe(1);
			expect(reads.at(-1)).toEqual([0x10000, 0x11000]);
			expect([...new Uint8Array(restored.memory.buffer, 0x10000, 4)]).toEqual([1, 2, 3, 4]);
			expect(restored.crashed).toBeFalsy();
		});

		it('wakes an idle cpu whose deadline was already overdue at checkpoint time', async () => {
			// the clock passes the 1 ms idle deadline without the pump running
			const { r, restored } = await checkpointed((rr) => (rr.clock.ns += 5_000_000n));
			restored.type('q');
			expect(await r.run(restored, () => false)).toBe('halted');
		});

		it('refuses to run the machine that checkpointed, whose stacks are now bytes', async () => {
			const { r, machine, restored } = await checkpointed();
			await expect(r.run(machine, () => true)).rejects.toThrow(
				/continue from Machine.restore/
			);
			restored.type('s');
			await r.run(restored, () => r.output().includes('parent back ok'));
			expect(r.output()).not.toContain('bad');
		});

		it('refuses a second checkpoint while one unwinds, and after one', async () => {
			const r = rig({ asyncify: true });
			const machine = new Machine(r.machineOptions);
			await r.run(machine, () => r.output().includes('parent ok'));
			const first = machine.checkpoint();
			await expect(machine.checkpoint()).rejects.toThrow('checkpointed already');
			const snapshot = await first;
			expect(snapshot.runners.some((s) => s.kernelStack)).toBe(true);
			await expect(machine.checkpoint()).rejects.toThrow('checkpointed already');
		});

		it('refuses while the pump runs or without asyncify', async () => {
			const plain = rig();
			const machine = new Machine(plain.machineOptions);
			await plain.run(machine, () => plain.output().includes('parent ok'));
			await expect(machine.checkpoint()).rejects.toThrow('checkpoint needs asyncify');
		});

		it('keeps a task the kernel released while its turn in the ready queue was still to come', async () => {
			const r = rig({ asyncify: true });
			const machine = new Machine(r.machineOptions);
			await r.run(machine, () => r.output().includes('parent ok'));
			machine.type('s');
			await r.run(machine, () => r.output().includes('echo:s'));
			// task 1 switched to task 2, which waits for its turn; the kernel releases it before then
			new DataView(machine.memory.buffer).setUint32(0x854, 2, true);
			machine.type(' ');
			const snapshot = await machine.checkpoint();
			expect(snapshot.runners.find((s) => s.id === 2)?.released).toBe(true);
			const restored = await Machine.restore(r.machineOptions, snapshot);
			await r.run(restored, () => r.output().includes('parent back ok'));
			expect(r.output()).toContain('child ok\nparent back ok');
			// that turn's switch was its last: its stack is unwound, not left parked
			expect(restored.stats.abandonedStacks).toBe(1);
		});

		it('unwinds the parked stack of a task the kernel released, and runs on', async () => {
			const r = rig({ asyncify: true });
			const machine = new Machine(r.machineOptions);
			await r.run(machine, () => r.output().includes('parent ok'));
			// task 2 parked in its switch back to task 1; releasing it leaves nothing to resume it
			new DataView(machine.memory.buffer).setUint32(0x854, 2, true);
			machine.type(' ');
			await r.run(machine, () => r.output().includes('echo: '));
			expect(machine.stats.abandonedStacks).toBe(1);
			expect(machine.crashed).toBeNull();
			const snapshot = await machine.checkpoint();
			expect(snapshot.runners.some((s) => s.id === 2)).toBe(false);
		});

		it('refuses, and can still run, while a program without asyncify is parked', async () => {
			const r = rig({
				asyncify: true,
				registry: new Map([['Z', toyUser('toy-sync-writes.wat')]])
			});
			const machine = new Machine(r.machineOptions);
			await r.run(machine, () => r.output().includes('parent ok'));
			machine.type('n');
			await r.run(machine, () => r.output().includes('user back'));
			await expect(machine.checkpoint()).rejects.toThrow('a program without asyncify');
			machine.type('s');
			await r.run(machine, () => r.output().includes('parent back ok'));
			expect(r.output()).toContain('parent back ok');
		});
	});

	describe('syscall counting', () => {
		const counted = async (countSyscalls: MachineOptions['countSyscalls']) => {
			const r = rig({
				sharedKernel: true,
				registry: new Map([['Y', toyUser('toy-sync.wat')]]),
				countSyscalls
			});
			const machine = new Machine(r.machineOptions);
			await r.run(machine, () => r.output().includes('parent ok'));
			machine.type('y');
			await r.run(machine, () => r.output().includes('user back'));
			return machine;
		};

		it('counts every call of a program by number and still reaches the kernel', async () => {
			const machine = await counted(true);
			// toy-sync.wat: fsync, fdatasync, then calls 2 and 4
			expect(machine.stats.syscalls).toMatchObject({ 82: 1, 83: 1, 2: 1, 4: 1 });
			const word = new DataView(machine.memory.buffer).getUint32(0x830, true);
			expect(word).toBe(2);
		});

		it('hands a function each call with its arguments and what the kernel returned', async () => {
			const calls: [number, number[], number | null][] = [];
			await counted((call) => calls.push([call.nr, call.args, call.ret]));
			const sync = calls.filter(([nr]) => nr === 82);
			expect(sync).toEqual([[82, [3], expect.any(Number)]]);
			expect(calls.every(([, , ret]) => ret !== null)).toBe(true);
		});

		it('counts nothing without the option', async () => {
			const machine = await counted(undefined);
			expect(machine.stats.syscalls).toEqual({});
		});
	});

	describe('file syncs', () => {
		const word = (m: Machine, at: number) => new DataView(m.memory.buffer).getUint32(at, true);

		it('hands an fsynced file to fileSync before the kernel syncs it, and routes everything else past', async () => {
			const synced: SyncedFile[] = [];
			const kernelSyncsSeen: number[] = [];
			let machine: Machine;
			const r = rig({
				sharedKernel: true,
				registry: new Map([['Y', toyUser('toy-sync.wat')]]),
				fileSync: async (file) => {
					await Promise.resolve();
					kernelSyncsSeen.push(word(machine, 0x830));
					synced.push(file);
				}
			});
			machine = new Machine(r.machineOptions);
			await r.run(machine, () => r.output().includes('parent ok'));
			machine.type('y');
			await r.run(machine, () => r.output().includes('user back'));
			expect(synced.map((f) => [f.path, f.mode, new TextDecoder().decode(f.bytes)])).toEqual([
				['/toy/file', 0o644, 'hello']
			]);
			// the kernel's own sync had not run when fileSync did; both reached it after
			expect(kernelSyncsSeen).toEqual([0]);
			expect(word(machine, 0x830)).toBe(2);
			expect(r.output()).toContain('handled\nuser back');
			expect(machine.stats).toMatchObject({
				fileSyncs: 1,
				fileSyncBytes: 5,
				fileSyncsSkipped: 1
			});
			// both syncs used one scratch mapping
			expect(word(machine, 0x84c)).toBe(1);
		});

		it('maps a new scratch region when the cached address now starts a smaller mapping', async () => {
			const r = rig({
				sharedKernel: true,
				registry: new Map([['Y', toyUser('toy-sync.wat')]]),
				fileSync: async () => {}
			});
			const machine = new Machine(r.machineOptions);
			await r.run(machine, () => r.output().includes('parent ok'));
			// as when a dead process's mm and mapping addresses come back for a new one
			new DataView(machine.memory.buffer).setUint32(0x850, 0x1000, true);
			machine.type('y');
			await r.run(machine, () => r.output().includes('user back'));
			expect(word(machine, 0x84c)).toBe(2);
		});

		it("writes a restore's files back at the first syscall, before it runs, and checkpoints only after", async () => {
			const r = rig({ asyncify: true, registry: new Map([['Y', toyUser('toy-sync.wat')]]) });
			const machine = new Machine(r.machineOptions);
			await r.run(machine, () => r.output().includes('parent ok'));
			const snapshot = await machine.checkpoint();
			const file = { path: '/a/b', mode: 0o600, bytes: new TextEncoder().encode('xyz') };
			const gone = { path: '/gone', mode: 0, bytes: new Uint8Array(0), removed: true };
			const restored = await Machine.restore(
				{ ...r.machineOptions, restoreFiles: [file, gone] },
				snapshot
			);
			await expect(restored.checkpoint()).rejects.toThrow(/wrote its files back/);
			restored.type('y');
			await r.run(restored, () => r.output().includes('user back'));
			const bytes = new Uint8Array(restored.memory.buffer);
			expect(new TextDecoder().decode(bytes.subarray(0x2800, 0x2803))).toBe('xyz');
			// one directory made on the way, then O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC
			expect(word(restored, 0x838)).toBe(1);
			expect(word(restored, 0x834)).toBe(0o2001101);
			// the removed one unlinked
			expect(word(restored, 0x848)).toBe(1);
			expect(restored.stats).toMatchObject({ filesRestored: 2, fileRestoreErrors: [] });
			// without fileSync the program's fsyncs go straight to the kernel
			expect(word(restored, 0x830)).toBe(2);
		});

		it('flushes a synchronous write, an MS_SYNC msync and a sync walk, and reports what a sync found gone', async () => {
			const synced: [string, string, boolean][] = [];
			const r = rig({
				asyncify: true,
				registry: new Map([['Z', toyUser('toy-sync-writes.wat', true)]]),
				fileSync: async (file) => {
					synced.push([file.path, new TextDecoder().decode(file.bytes), !!file.removed]);
				}
			});
			const machine = new Machine(r.machineOptions);
			await r.run(machine, () => r.output().includes('parent ok'));
			machine.type('n');
			await r.run(machine, () => r.output().includes('user back'));
			expect(synced).toEqual([
				// the O_SYNC write to fd 5; the write to fd 6 and the MS_ASYNC msync flush nothing
				['/toy/file', 'hello', false],
				// the MS_SYNC msync, by the mapping's file in /proc/self/maps
				['/toy/file', 'hello', false],
				// sync walks / and finds /file, and /toy/file no longer there
				['/file', 'hello', false],
				['/toy/file', '', true]
			]);
			// both writes reached the kernel, and the program's openat kept O_SYNC
			expect(word(machine, 0x840)).toBe(6);
			expect(machine.stats).toMatchObject({ fileSyncs: 3, syncWalks: 1, fileRemovals: 1 });
			const snapshot = await machine.checkpoint();
			expect(snapshot.syncWrites).toBe(true);
		});

		it('asks for the runtime option when a feature needs the router', () => {
			for (const option of [
				{ syscallCache: true as const },
				{ countSyscalls: true },
				{ fileSync: async () => {} }
			])
				expect(
					() => new Machine({ ...rig(option).machineOptions, runtime: undefined })
				).toThrow(/MachineOptions\.runtime/);
		});

		it('refuses a statx cache over a kernel with no wasm_fs_block', async () => {
			const r = rig({
				sharedKernel: true,
				syscallCache: true,
				registry: new Map([['T', toyUser('toy-statx.wat')]])
			});
			const machine = new Machine(r.machineOptions);
			const exp = (machine as any).exp.bind(machine);
			(machine as any).exp = (runner: unknown) => ({
				...exp(runner),
				wasm_fs_block: undefined
			});
			await r.run(machine, () => r.output().includes('parent ok'));
			machine.type('t');
			expect(await r.run(machine, () => r.output().includes('handled'))).toBe('crashed');
			expect(String(machine.crashed)).toMatch(/patch 0036/);
		});

		describe('statx cache', () => {
			const statxRig = (syscallCache: true | 'verify') => {
				const r = rig({
					sharedKernel: true,
					syscallCache,
					registry: new Map([['T', toyUser('toy-statx.wat')]])
				});
				const machine = new Machine(r.machineOptions);
				const set = (at: number, v: number) =>
					new DataView(machine.memory.buffer).setUint32(at, v, true);
				return { r, machine, set };
			};
			// the toy kernel's wasm_fs_block: the generation, the mount count and the inode counters
			const BLOCK = 0x18000;
			const MOUNTS = BLOCK + FS_MOVES;
			const counter = (ino: number) => BLOCK + FS_COUNTERS + statxBucket(ino) * 4;

			it('holds an answer on the inodes its path crossed, and not on the generation', async () => {
				const { r, machine, set } = statxRig(true);
				await r.run(machine, () => r.output().includes('parent ok'));
				machine.type('t');
				await r.run(machine, () => r.output().includes('handled'));
				// the kernel's answer and the relative path; the fill walks the path in one call
				expect(word(machine, 0x860)).toBe(2);
				expect(new DataView(machine.memory.buffer).getBigUint64(0x3000 + 40, true)).toBe(
					5n
				);
				expect(machine.stats).toMatchObject({
					statxHits: 1,
					statxMisses: 2,
					statxFills: 1,
					statxFineFills: 1,
					statxChains: 1
				});
				// the toy's view is 1, and the program asks with no flags and the basic mask
				const hash = statxHash(new Uint8Array(machine.memory.buffer), 0x750, 1, 0, 0x7ff)!;
				const held = (machine as any).fsCache.get(hash);
				expect(held.guards.map(([index]: number[]) => index)).toEqual(
					[10, 11, 12].map(statxBucket)
				);
				// a write anywhere, and a change to an inode that is not on the path
				set(BLOCK, 7);
				set(counter(99), 1);
				machine.type('r');
				await r.run(machine, () => r.output().includes('user back'));
				expect(word(machine, 0x860)).toBe(2);
				expect(machine.stats).toMatchObject({
					statxHits: 3,
					statxMisses: 2,
					statxFills: 1,
					statxMismatches: 0
				});
			});

			it.each([
				['the file', () => counter(12)],
				['a directory above it', () => counter(11)],
				['the root', () => counter(10)],
				['the mount tree', () => MOUNTS]
			])('refills an answer once a counter of %s moves', async (_name, at) => {
				const { r, machine, set } = statxRig(true);
				await r.run(machine, () => r.output().includes('parent ok'));
				machine.type('t');
				await r.run(machine, () => r.output().includes('handled'));
				set(at(), 1);
				machine.type('r');
				await r.run(machine, () => r.output().includes('user back'));
				// the refill asks the kernel once and walks the path once
				expect(word(machine, 0x860)).toBe(3);
				expect(machine.stats).toMatchObject({
					statxHits: 2,
					statxMisses: 3,
					statxFills: 2,
					statxFineFills: 2,
					statxChains: 2
				});
			});

			describe('the inodes a lookup depends on', () => {
				const DIR = 0o040755;
				const FILE = 0o100644;
				const LINK = 0o120777;
				const AT_SYMLINK_NOFOLLOW = 0x100;
				const root = { mount: 1, ino: 2, mode: DIR };
				type Probe = { mount: number; ino: number; mode: number } | undefined | null;
				// what a statx of each prefix answers: a directory or file, a symlink, none, or an error
				const entry = (ino: number, mode = DIR, mount = 1): Probe => ({ mount, ino, mode });
				const chain = (
					name: string,
					result: number,
					probes: Record<string, Probe>,
					flags = AT_SYMLINK_NOFOLLOW
				) => {
					const memory = new WebAssembly.Memory({ initial: 1 });
					const bytes = new Uint8Array(memory.buffer);
					const view = new DataView(memory.buffer);
					const asked: string[] = [];
					// what wasm_fs_chain writes: the root, then each prefix up to a missing one, a
					// file or another mount; an unanswered prefix is not one the dcache can answer
					const kernel = {
						wasm_fs_chain(len: number) {
							const parts = new TextDecoder()
								.decode(bytes.subarray(FS_PATH, FS_PATH + len))
								.split('/')
								.filter(Boolean);
							const links = [root];
							for (let i = 1; i <= parts.length; i++) {
								const path = `/${parts.slice(0, i).join('/')}`;
								asked.push(path);
								const probe = probes[path];
								if (probe === undefined) break;
								if (probe === null) return -11;
								links.push(probe);
								if (
									(probe.mode & 0o170000) !== 0o040000 ||
									probe.mount !== root.mount
								)
									break;
							}
							links.forEach((link, i) => {
								view.setUint32(FS_CHAIN + i * 12, link.mount, true);
								view.setUint32(FS_CHAIN + i * 12 + 4, link.ino, true);
								view.setUint32(FS_CHAIN + i * 12 + 8, link.mode, true);
							});
							return links.length;
						}
					};
					const host = {
						stats: { statxChains: 0 },
						fsBlockAt: 0,
						memory,
						viewsOf: () => ({ bytes, view }),
						exp: () => kernel
					};
					const walk = (Machine.prototype as any).statxChain as Function;
					const path = new TextEncoder().encode(name);
					return { inos: walk.call(host, null, { path, flags }, result), asked };
				};
				const tree = {
					'/usr': entry(3),
					'/usr/lib': entry(4),
					'/usr/lib/x': entry(5, FILE),
					'/usr/link': entry(6, LINK),
					'/usr/file': entry(7, FILE)
				};

				it('is the root and each prefix of the path', async () => {
					expect(await chain('/usr/lib/x', 0, tree)).toEqual({
						inos: [2, 3, 4, 5],
						asked: ['/usr', '/usr/lib', '/usr/lib/x']
					});
					expect((await chain('/', 0, tree)).inos).toEqual([2]);
					expect((await chain('//usr//lib/', 0, tree)).inos).toEqual([2, 3, 4]);
				});

				it('ends at the last prefix that exists for a missing path', async () => {
					expect((await chain('/usr/lib/none', -2, tree)).inos).toEqual([2, 3, 4]);
					expect((await chain('/usr/none/deeper', -2, tree)).inos).toEqual([2, 3]);
					// the kernel said missing and every prefix is there: not an answer to hold
					expect((await chain('/usr/lib/x', -2, tree)).inos).toBeNull();
					// and the kernel found it where a prefix is missing
					expect((await chain('/usr/none', 0, tree)).inos).toBeNull();
				});

				it('ends at a file that has more path after it, or a slash', async () => {
					expect((await chain('/usr/file/x', -20, tree)).inos).toEqual([2, 3, 7]);
					expect((await chain('/usr/file/', -20, tree)).inos).toEqual([2, 3, 7]);
					expect((await chain('/usr/file/x', 0, tree)).inos).toBeNull();
				});

				it('gives up on a dot, a dotdot or a symlink it would follow', async () => {
					expect((await chain('/usr/../usr/lib', 0, tree)).inos).toBeNull();
					expect((await chain('/usr/./lib', 0, tree)).inos).toBeNull();
					expect((await chain('/usr/link/x', 0, tree)).inos).toBeNull();
					expect((await chain('/usr/link', 0, tree, 0)).inos).toBeNull();
					expect((await chain('/usr/link/', 0, tree)).inos).toBeNull();
					// a final symlink asked about itself is an inode like another
					expect((await chain('/usr/link', 0, tree)).inos).toEqual([2, 3, 6]);
				});

				it('gives up on another mount, an unanswered prefix or too long a path', async () => {
					expect(
						(await chain('/usr/lib', 0, { ...tree, '/usr/lib': entry(4, DIR, 9) })).inos
					).toBeNull();
					expect(
						(await chain('/usr/lib', 0, { ...tree, '/usr/lib': null })).inos
					).toBeNull();
					const deep = (parts: number) => {
						const probes: Record<string, Probe> = {};
						let path = '';
						for (let i = 1; i <= parts; i++) probes[(path += `/d${i}`)] = entry(10 + i);
						return chain(path, 0, probes);
					};
					expect((await deep(STATX_GUARDS - 1)).inos).toHaveLength(STATX_GUARDS);
					expect((await deep(STATX_GUARDS)).inos).toBeNull();
				});
			});

			it('leaves a buffer outside the memory to the kernel instead of throwing', async () => {
				const { r, machine } = statxRig(true);
				await r.run(machine, () => r.output().includes('parent ok'));
				machine.type('t');
				await r.run(machine, () => r.output().includes('handled'));
				const me = [...(machine as any).runners.values()].find((x: any) => x.instance);
				const kernel = (machine as any).exp(me);
				const hit = new WebAssembly.Instance(RUNTIME.statx, {
					env: {
						user: machine.memory,
						table: (machine as any).fsCache.memory,
						machine: machine.memory
					},
					kernel: { block: kernel.wasm_fs_block, view: kernel.wasm_fs_view }
				}).exports.hit as (...args: number[]) => number;
				const ask = (buf: number) => hit(0, 0, 291, -100, 0x750, 0, 0x7ff, buf);
				const size = machine.memory.buffer.byteLength;
				expect(ask(0x3000)).toBe(0);
				expect(ask(size - 255)).toBe(MISS);
				expect(ask(0xffffff80)).toBe(MISS);
				expect(ask(size - 256)).toBe(0);
			});

			it('asks the kernel for a task whose view is not cacheable', async () => {
				const { r, machine, set } = statxRig(true);
				await r.run(machine, () => r.output().includes('parent ok'));
				set(0x85c, 0);
				machine.type('t');
				await r.run(machine, () => r.output().includes('handled'));
				expect(word(machine, 0x860)).toBe(3);
				expect(machine.stats).toMatchObject({ statxHits: 0, statxFills: 0 });
			});

			it('verifies every answer it would give against the kernel', async () => {
				const { r, machine, set } = statxRig('verify');
				await r.run(machine, () => r.output().includes('parent ok'));
				machine.type('t');
				await r.run(machine, () => r.output().includes('handled'));
				// the size changes with no generation step: a stale answer the kernel contradicts
				set(0x864, 9);
				machine.type('r');
				await r.run(machine, () => r.output().includes('user back'));
				expect(machine.stats.statxHits).toBe(0);
				expect(machine.stats.statxMismatches).toBe(1);
			});
		});

		describe("a fork child's own memory", () => {
			const childRig = () => {
				const machine = new Machine(rig().machineOptions);
				const child = new WebAssembly.Memory({ initial: 2, maximum: 64, shared: true });
				// the toy kernel's current mm is 1
				(machine as any).privateMemories.set(1, child);
				const runner = { instance: { exports: { wasm_current_mm: () => 1 } } };
				const imports = (machine as any).rawImports(() => runner);
				return {
					machine,
					child: new Uint8Array(child.buffer),
					kernel: new Uint8Array(machine.memory.buffer),
					copy: imports.wasm_user_copy as (
						k: number,
						u: number,
						n: number,
						m: number
					) => number,
					atomic: imports.wasm_user_atomic as (...a: number[]) => number,
					string: imports.wasm_user_string as (
						k: number,
						u: number,
						count: number,
						mode: number
					) => number
				};
			};

			it('copies to and from the kernel through the host and counts the crossings', () => {
				const { machine, child, kernel, copy } = childRig();
				kernel.set([1, 2, 3, 4, 5], 0x1000);
				expect(copy(0x1000, 0x200, 5, 1)).toBe(0);
				expect(child.subarray(0x200, 0x205)).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
				expect(kernel[0x200]).toBe(0);
				expect(copy(0x2000, 0x200, 5, 0)).toBe(0);
				expect(kernel.subarray(0x2000, 0x2005)).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
				expect(copy(0, 0x200, 3, 2)).toBe(0);
				expect(child.subarray(0x200, 0x205)).toEqual(new Uint8Array([0, 0, 0, 4, 5]));
				expect(machine.stats).toMatchObject({ userCopies: 3, userCopyBytes: 13 });
			});

			it('reports the bytes it could not reach for a span past the child memory', () => {
				const { child, copy } = childRig();
				const size = child.length;
				for (const mode of [0, 1, 2]) {
					expect(copy(0x1000, size - 4, 8, mode)).toBe(8);
					expect(copy(0x1000, 0xfffffffc, 8, mode)).toBe(8);
				}
				expect(child.subarray(size - 4).every((b) => b === 0)).toBe(true);
			});

			it('reads a string in one crossing, as strncpy_from_user and strnlen_user do', () => {
				const { machine, child, kernel, string } = childRig();
				const put = (at: number, text: string) =>
					child.set(
						Array.from(text, (c) => c.charCodeAt(0)),
						at
					);
				put(0x201, 'hello\0world');
				kernel.fill(0xaa, 0x1000, 0x1010);
				expect(string(0x1000, 0x201, 16, 0)).toBe(5);
				expect(kernel.subarray(0x1000, 0x1007)).toEqual(
					new Uint8Array([104, 101, 108, 108, 111, 0, 0xaa])
				);
				expect(string(0, 0x201, 16, 1)).toBe(6);
				// no NUL within count: count (strnlen_user: count + 1), and only count bytes copied
				put(0x300, 'abcdefgh');
				kernel.fill(0xaa, 0x1100, 0x1110);
				expect(string(0x1100, 0x300, 4, 0)).toBe(4);
				expect(kernel.subarray(0x1100, 0x1105)).toEqual(
					new Uint8Array([97, 98, 99, 100, 0xaa])
				);
				expect(string(0, 0x300, 4, 1)).toBe(5);
				// the NUL is the last byte counted
				put(0x400, 'abc\0');
				expect(string(0x1200, 0x400, 4, 0)).toBe(3);
				expect(string(0, 0x400, 4, 1)).toBe(4);
				expect(string(0, 0x400, 3, 1)).toBe(4);
				expect(machine.stats).toMatchObject({ userStrings: 7, userStringBytes: 6 + 4 + 4 });
			});

			it('fails a string that runs out of the child memory as Linux does', () => {
				const { child, string } = childRig();
				const size = child.length;
				child.fill(120, size - 16);
				// -EFAULT from strncpy_from_user, 0 from strnlen_user, the NUL at the very end is read
				expect(string(0x1000, size - 16, 64, 0)).toBe(-14);
				expect(string(0, size - 16, 64, 1)).toBe(0);
				expect(string(0x1000, size, 8, 0)).toBe(-14);
				expect(string(0, size, 8, 1)).toBe(0);
				expect(string(0x1000, 0xfffffff0, 8, 0)).toBe(-14);
				// count reached exactly at the end is not a fault
				expect(string(0x1000, size - 16, 16, 0)).toBe(16);
				expect(string(0, size - 16, 16, 1)).toBe(17);
				child[size - 1] = 0;
				expect(string(0x1000, size - 16, 64, 0)).toBe(15);
				expect(string(0, size - 16, 64, 1)).toBe(16);
			});

			it('refuses a futex word outside the child memory or unaligned with EFAULT', () => {
				const { child, atomic } = childRig();
				const at = (uaddr: number) => atomic(1, uaddr, 5, 0, 0x1000);
				expect(at(0x100)).toBe(0);
				expect(new Int32Array(child.buffer)[0x40]).toBe(5);
				expect(at(child.length)).toBe(-14);
				expect(at(child.length - 2)).toBe(-14);
				expect(at(0x101)).toBe(-14);
			});
		});

		it('routes each syscall by the route global', () => {
			const seen: string[] = [];
			const route = new WebAssembly.Global({ value: 'i32', mutable: true }, ROUTE_WATCH);
			const k: Record<string, unknown> = {};
			const h: Record<string, unknown> = {};
			for (let n = 0; n <= 6; n++) {
				k[n] = (_sp: number, _tls: number, nr: number) => (seen.push(`k${nr}`), 0);
				h[n] = (_sp: number, _tls: number, nr: number) => (seen.push(`h${nr}`), 0);
			}
			const router = (cache: boolean, answer: number) =>
				new WebAssembly.Instance(RUNTIME.route, {
					k: k as WebAssembly.ModuleImports,
					h: h as WebAssembly.ModuleImports,
					c: {
						5: (_sp: number, _tls: number, nr: number) => (seen.push(`c${nr}`), answer)
					},
					env: {
						memory: new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }),
						route,
						cache: new WebAssembly.Global(
							{ value: 'i32', mutable: true },
							cache ? 1 : 0
						)
					}
				}).exports as Record<string, (...a: number[]) => number>;
			let s = router(false, MISS);
			const calls = () => {
				s.s0!(0, 0, 81);
				s.s1!(0, 0, 82, 3);
				s.s3!(0, 0, 64, 5, 0, 1);
				s.s4!(0, 0, 56, -100, 0, 1, 0);
				s.s4!(0, 0, 56, -100, 0, 0o4010001, 0);
				s.s3!(0, 0, 63, 5, 0, 1);
				s.s5!(0, 0, 291, -100, 0, 0, 0, 0);
			};
			calls();
			route.value = ROUTE_WRITES;
			calls();
			route.value = ROUTE_KERNEL;
			calls();
			route.value = ROUTE_HOOK;
			calls();
			expect(seen).toEqual([
				...['h81', 'h82', 'k64', 'k56', 'h56', 'k63', 'k291'],
				...['h81', 'h82', 'h64', 'k56', 'h56', 'k63', 'k291'],
				...['k81', 'k82', 'k64', 'k56', 'k56', 'k63', 'k291'],
				...['h81', 'h82', 'h64', 'h56', 'h56', 'h63', 'h291']
			]);
			// with the cache: a miss fills through the hook, a hit answers alone
			seen.length = 0;
			route.value = ROUTE_WATCH;
			s = router(true, MISS);
			expect(s.s5!(0, 0, 291, -100, 0, 0, 0, 0)).toBe(0);
			s = router(true, -2);
			expect(s.s5!(0, 0, 291, -100, 0, 0, 0, 0)).toBe(-2);
			route.value = ROUTE_KERNEL;
			s.s5!(0, 0, 291, -100, 0, 0, 0, 0);
			route.value = ROUTE_HOOK;
			s.s5!(0, 0, 291, -100, 0, 0, 0, 0);
			expect(seen).toEqual(['c291', 'h291', 'c291', 'k291', 'h291']);
		});

		it('reports the earliest Linux deadline an idle task waits for, on the kernel clock', async () => {
			const r = rig();
			const machine = new Machine(r.machineOptions);
			expect(machine.deadline).toBeNull();
			await r.run(machine, () => r.output().includes('parent ok'));
			// init idles on a 1 ms deadline
			expect(machine.deadline! - machine.clockNs).toBeLessThanOrEqual(1_000_000n);
			expect(machine.deadline).not.toBeNull();
		});
	});

	describe('the stream relay', () => {
		/** the toy kernel with its interrupt cpu up and a program listening on port 80 */
		async function listening() {
			const r = rig({ asyncify: true, sharedKernel: true });
			const machine = new Machine(r.machineOptions);
			await r.run(machine, () => r.output().includes('parent ok'));
			machine.type('k');
			await r.run(machine, () => r.output().includes('echo:k'));
			expect(machine.listening(80)).toBe(false);
			expect(() => machine.ingress(80)).toThrow('nothing listens on port 80');
			machine.type('l');
			await r.run(machine, () => r.output().includes('echo:l'));
			const drive = async <T>(work: Promise<T>) => {
				let done = false;
				const result = work.finally(() => (done = true));
				await r.run(machine, () => done);
				return result;
			};
			return { r, machine, drive };
		}

		it('carries bytes both ways to a listening program and empties its table at the close', async () => {
			const { machine, drive } = await listening();
			expect(machine.listening(80)).toBe(true);
			const stream = machine.ingress(80);
			const reader = stream.readable.getReader();
			const echoed = await drive(
				(async () => {
					await stream.write('hello');
					return new TextDecoder().decode((await reader.read()).value);
				})()
			);
			expect(echoed).toBe('hello');
			expect(machine.openStreams).toBe(1);
			stream.end();
			expect((await drive(reader.read())).done).toBe(true);
			expect(machine.openStreams).toBe(0);
			expect(machine.stats).toMatchObject({
				netOpens: 1,
				netBytesIn: 5,
				netBytesOut: 5,
				netSends: 1
			});
			expect(machine.stats.netEvents).toBe(3);
		});

		it('refuses a checkpoint while a stream is open and takes it once the stream is gone', async () => {
			const { r, machine, drive } = await listening();
			const stream = machine.ingress(80);
			await expect(machine.checkpoint()).rejects.toThrow('streams are open');
			stream.abort();
			await drive(new Promise((resolve) => setTimeout(resolve, 0)));
			expect(machine.openStreams).toBe(0);
			const snapshot = await machine.checkpoint();
			expect(snapshot.ports).toEqual([80]);
			const restored = await Machine.restore(r.machineOptions, snapshot);
			expect(restored.listening(80)).toBe(true);
			expect(restored.listening(81)).toBe(false);
		});

		it('keeps a port that two programs listen on until both have stopped', () => {
			const net = new Ingress(netStats(), () => {});
			net.listen(80, true);
			net.listen(80, true);
			expect(net.listeners).toEqual([80, 80]);
			net.listen(80, false);
			expect(net.listening(80)).toBe(true);
			net.listen(80, false);
			net.listen(80, false);
			expect(net.listening(80)).toBe(false);
			net.restore([8080, 8080, 80]);
			expect(net.listeners.sort()).toEqual([80, 8080, 8080]);
		});

		describe('the host end', () => {
			const EVENT = 0x100;
			const BUF = 0x200;
			function rigNet() {
				const memory = new WebAssembly.Memory({ initial: 1 });
				const stats = netStats();
				const raised = { n: 0 };
				const net = new Ingress(stats, () => raised.n++);
				net.listen(80, true);
				const next = (cap = 64) => {
					const got = net.next(memory, EVENT, BUF, cap);
					const view = new DataView(memory.buffer);
					return {
						got,
						op: view.getUint32(EVENT, true),
						id: view.getUint32(EVENT + 4, true),
						arg: view.getUint32(EVENT + 8, true),
						bytes: new Uint8Array(
							memory.buffer,
							BUF,
							view.getUint32(EVENT + 8, true)
						).slice()
					};
				};
				return { net, stats, raised, next };
			}

			it('hands the kernel an open, then the bytes in pieces no bigger than it asked for, then the end', async () => {
				const { net, stats, raised, next } = rigNet();
				const stream = net.connect(80);
				expect(raised.n).toBe(1);
				expect(next()).toMatchObject({ op: 1, id: stream.id, arg: 80 });
				let taken = false;
				const wrote = stream.write(new Uint8Array(150).fill(7)).then(() => (taken = true));
				expect(next(64)).toMatchObject({ op: 2, arg: 64 });
				expect(next(64)).toMatchObject({ op: 2, arg: 64 });
				await Promise.resolve();
				expect(taken).toBe(false);
				expect(next(64)).toMatchObject({ op: 2, arg: 22 });
				await wrote;
				expect(next().got).toBe(0);
				stream.end();
				expect(next()).toMatchObject({ op: 3, id: stream.id });
				expect(stats.netBytesIn).toBe(150);
				expect(net.open).toBe(1);
				net.end(stream.id, 0);
				expect(net.open).toBe(0);
			});

			it('holds back a stream the kernel asks it to, and wakes the kernel when it is let go', () => {
				const { net, raised, next } = rigNet();
				const first = net.connect(80);
				const second = net.connect(80);
				next();
				next();
				first.write('aa').catch(() => {});
				second.write('bb').catch(() => {});
				net.end(first.id, 2);
				const before = raised.n;
				expect(next()).toMatchObject({ op: 2, id: second.id });
				expect(next().got).toBe(0);
				net.end(first.id, 3);
				expect(raised.n).toBe(before + 1);
				expect(next()).toMatchObject({ op: 2, id: first.id });
			});

			it('takes what the reader has room for, then answers 0 and raises the interrupt once it reads', async () => {
				const { net, stats, raised } = rigNet();
				const stream = net.connect(80);
				expect(net.send(stream.id, new Uint8Array(READ_BUFFER + 10))).toBe(READ_BUFFER);
				expect(net.send(stream.id, new Uint8Array(10))).toBe(0);
				expect(stats.netBackpressure).toBe(2);
				expect(stats.netBytesOut).toBe(READ_BUFFER);
				const before = raised.n;
				const reader = stream.readable.getReader();
				expect((await reader.read()).value).toHaveLength(READ_BUFFER);
				expect(raised.n).toBe(before + 1);
				expect(net.send(stream.id, new Uint8Array(10))).toBe(10);
			});

			it('wakes the kernel from a poll for a starved stream whose reader has room though no pull said so', async () => {
				const { net, raised } = rigNet();
				const stream = net.connect(80) as unknown as {
					id: number;
					starved: boolean;
					readable: ReadableStream<Uint8Array>;
				};
				net.send(stream.id, new Uint8Array(READ_BUFFER + 10));
				const before = raised.n;
				net.poll();
				expect(raised.n).toBe(before);
				await stream.readable.getReader().read();
				expect(raised.n).toBe(before + 1);
				stream.starved = true;
				net.poll();
				expect(raised.n).toBe(before + 2);
				net.poll();
				expect(raised.n).toBe(before + 2);
			});

			it('delivers an abort once, rejects what was waiting, and answers a late send with closed', async () => {
				const { net, next } = rigNet();
				const stream = net.connect(80);
				next();
				const waiting = stream.write('late');
				stream.abort();
				await expect(waiting).rejects.toThrow('aborted');
				await expect(stream.write('more')).rejects.toThrow('closed');
				expect(next()).toMatchObject({ op: 4, id: stream.id });
				expect(net.open).toBe(0);
				expect(net.send(stream.id, new Uint8Array(1))).toBe(-1);
				expect(next().got).toBe(0);
			});

			it('never tells the kernel of a stream it aborted before the kernel saw it', () => {
				const { net, next } = rigNet();
				net.connect(80).abort();
				expect(net.open).toBe(0);
				expect(next().got).toBe(0);
			});

			it('errors the reader and the writes at a reset, and drops the stream', async () => {
				const { net, next } = rigNet();
				const stream = net.connect(80);
				next();
				const reader = stream.readable.getReader();
				const waiting = stream.write('x');
				net.end(stream.id, 1);
				await expect(waiting).rejects.toThrow('reset');
				await expect(reader.read()).rejects.toThrow('reset');
				expect(net.open).toBe(0);
			});

			it('keeps a stream whose guest ended until the host has ended too', async () => {
				const { net, next } = rigNet();
				const stream = net.connect(80);
				next();
				const reader = stream.readable.getReader();
				net.end(stream.id, 0);
				expect((await reader.read()).done).toBe(true);
				expect(net.open).toBe(1);
				stream.end();
				next();
				expect(net.open).toBe(0);
			});
		});
	});
});

function netStats(): NetStats {
	return {
		netOpens: 0,
		netEvents: 0,
		netSends: 0,
		netBytesIn: 0,
		netBytesOut: 0,
		netBackpressure: 0
	};
}
