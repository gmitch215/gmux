import binaryen from 'binaryen';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Machine, type MachineOptions } from '../../src/worker/machine/machine.ts';

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
		binaryen.Features.Atomics | binaryen.Features.MutableGlobals | binaryen.Features.BulkMemory
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
function toyUser(name = 'toy-user.wat'): WebAssembly.Module {
	const module = parse(name);
	module.setFeatures(
		binaryen.Features.Atomics | binaryen.Features.MutableGlobals | binaryen.Features.MultiMemory
	);
	const bytes = module.emitBinary();
	module.dispose();
	return new WebAssembly.Module(bytes);
}

/** tests/fixtures/toy-shared.wat with share.py's mark: 16 bytes of data */
function toyShared(): WebAssembly.Module {
	const module = parse('toy-shared.wat');
	module.setFeatures(binaryen.Features.Atomics | binaryen.Features.MutableGlobals);
	module.addCustomSection('gmux.share', new Uint8Array([16, 0, 0, 0]));
	const bytes = module.emitBinary();
	module.dispose();
	return new WebAssembly.Module(bytes);
}

/** a toy user program built with experiments/evacuation/scripts/evacuate.mjs --resume */
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
	const script = new URL('../../experiments/evacuation/scripts/evacuate.mjs', import.meta.url);
	execFileSync(process.execPath, [
		script.pathname,
		join(dir, 'in.wasm'),
		join(dir, 'out.wasm'),
		'--resume'
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

		it('leaves memory as the snapshot recorded it until the machine runs again', async () => {
			const { restored, snapshot } = await checkpointed();
			const now = new Uint8Array(restored.memory.buffer);
			const [from, to] = [snapshot.scratch, snapshot.scratch + 32 * 0x10000];
			let changed = 0;
			for (let i = 0; i < snapshot.memory.byteLength; i++)
				if ((i < from || i >= to) && now[i] !== snapshot.memory[i]) changed++;
			expect(changed).toBe(0);
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

		it('refuses while the pump runs or without asyncify', async () => {
			const plain = rig();
			const machine = new Machine(plain.machineOptions);
			await plain.run(machine, () => plain.output().includes('parent ok'));
			await expect(machine.checkpoint()).rejects.toThrow('checkpoint needs asyncify');
		});
	});
});
