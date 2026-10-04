import binaryen from 'binaryen';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { routerModules } from '../../scripts/wasm/router-modules.ts';
import { CORE_ABI, coreRegionPages, loadCore, type Core } from '../../src/worker/machine/core.ts';
import { Machine, type MachineOptions } from '../../src/worker/machine/machine.ts';

const WORDS = 0x1000;
let built: WebAssembly.Module;

beforeAll(() => {
	const out = mkdtempSync(join(tmpdir(), 'gmux-core-'));
	execFileSync(new URL('../../scripts/build-core.sh', import.meta.url).pathname, [out]);
	built = new WebAssembly.Module(readFileSync(join(out, 'gmux-core.wasm')));
});

/** a core over a fresh shared memory, with sixteen interrupt words at WORDS */
function rig() {
	const memory = new WebAssembly.Memory({ initial: 2, maximum: 64, shared: true });
	const base = memory.grow(coreRegionPages(built)) * 0x10000;
	const core = loadCore(built, memory, base);
	const words = new BigInt64Array(memory.buffer, WORDS, 16);
	return { core, words, memory, base, address: (i: number) => WORDS + i * 8 };
}

const queued = (core: Core) =>
	Array.from({ length: core.core_ready_count() }, (_, i) => core.core_ready_at(i));

describe('the scheduler core', () => {
	it('reports the ABI the host speaks', () => {
		expect(rig().core.core_version()).toBe(CORE_ABI);
	});

	it('picks a cpu whose interrupt word is raised, and only then', () => {
		const { core, words, address } = rig();
		core.core_idle(1, 10, address(0), -1n);
		expect(core.core_pick(0n)).toBe(-1);
		words[0] = 4n;
		expect(core.core_pick(0n)).toBe(1);
		expect(core.core_idle_count()).toBe(0);
		expect(core.core_pick(0n)).toBe(-1);
	});

	it('sees the high half of a word', () => {
		const { core, words, address } = rig();
		core.core_idle(1, 10, address(0), -1n);
		words[0] = 1n << 40n;
		expect(core.core_pick(0n)).toBe(1);
	});

	it('breaks a tie by the order the host listed the cpus in, not by who armed first', () => {
		const { core, words, address } = rig();
		core.core_idle(5, 30, address(0), -1n);
		core.core_idle(6, 10, address(1), -1n);
		core.core_idle(7, 20, address(2), -1n);
		words[0] = words[1] = words[2] = 1n;
		expect([core.core_pick(0n), core.core_pick(0n), core.core_pick(0n)]).toEqual([6, 7, 5]);
		expect(core.core_pick(0n)).toBe(-1);
	});

	it('keeps one entry per cpu when it arms again', () => {
		const { core, words, address } = rig();
		core.core_idle(1, 10, address(0), -1n);
		core.core_idle(2, 20, address(1), -1n);
		core.core_idle(1, 10, address(0), -1n);
		expect(core.core_idle_count()).toBe(2);
		words[0] = words[1] = 1n;
		expect(core.core_pick(0n)).toBe(1);
	});

	it('reports the earliest deadline, and none for a wait with no deadline', () => {
		const { core, address } = rig();
		expect(core.core_deadline()).toBe(-1n);
		core.core_idle(1, 1, address(0), -1n);
		expect(core.core_deadline()).toBe(-1n);
		core.core_idle(2, 2, address(1), 300n);
		core.core_idle(3, 3, address(2), 100n);
		core.core_idle(4, 4, address(3), 200n);
		expect(core.core_deadline()).toBe(100n);
		expect(core.core_cancel(3)).toBe(1);
		expect(core.core_deadline()).toBe(200n);
		expect(core.core_cancel(3)).toBe(0);
	});

	it('picks a cpu whose deadline is at or before now, the first by order', () => {
		const { core, address } = rig();
		core.core_idle(1, 1, address(0), 500n);
		core.core_idle(2, 2, address(1), 100n);
		expect(core.core_pick(99n)).toBe(-1);
		expect(core.core_pick(100n)).toBe(2);
		expect(core.core_deadline()).toBe(500n);
		core.core_idle(2, 2, address(1), 100n);
		expect(core.core_pick(1000n)).toBe(1);
		expect(core.core_pick(1000n)).toBe(2);
	});

	it('picks at once a cpu that arms with a deadline already in the past', () => {
		const { core, address } = rig();
		core.core_idle(1, 1, address(0), 5n);
		expect(core.core_pick(1_000_000n)).toBe(1);
	});

	it('treats a deadline of zero as a deadline, and a negative one as none', () => {
		const { core, address } = rig();
		core.core_idle(1, 1, address(0), 0n);
		core.core_idle(2, 2, address(1), -5n);
		expect(core.core_deadline()).toBe(0n);
		expect(core.core_pick(0n)).toBe(1);
		expect(core.core_pick(1_000_000n)).toBe(-1);
	});

	it('refuses an idle wait when the table is full', () => {
		const { core, address } = rig();
		for (let slot = 0; slot < 256; slot++)
			expect(core.core_idle(slot, slot, address(0), -1n)).toBe(0);
		expect(core.core_idle(256, 256, address(0), -1n)).toBe(-1);
		expect(core.core_idle(255, 255, address(0), -1n)).toBe(0);
		core.core_reset();
		expect(core.core_idle_count()).toBe(0);
	});

	it('runs the ready queue first in, first out, with unshift in front', () => {
		const { core } = rig();
		expect(core.core_ready_shift()).toBe(-1);
		core.core_ready_push(1);
		core.core_ready_push(2);
		core.core_ready_unshift(3);
		expect(queued(core)).toEqual([3, 1, 2]);
		expect(core.core_ready_at(3)).toBe(-1);
		expect([core.core_ready_shift(), core.core_ready_shift(), core.core_ready_shift()]).toEqual(
			[3, 1, 2]
		);
		expect(core.core_ready_shift()).toBe(-1);
	});

	it('wraps the ready queue around its ring and refuses a push when full', () => {
		const { core } = rig();
		for (let i = 0; i < 3000; i++) {
			core.core_ready_push(i);
			core.core_ready_unshift(i + 1);
			expect(core.core_ready_shift()).toBe(i + 1);
			expect(core.core_ready_shift()).toBe(i);
		}
		for (let i = 0; i < 1024; i++) expect(core.core_ready_push(i)).toBe(0);
		expect(core.core_ready_push(0)).toBe(-1);
		expect(core.core_ready_unshift(0)).toBe(-1);
		expect(core.core_ready_count()).toBe(1024);
	});

	it('decides like a walk of the host list over random waits, words and clocks', () => {
		const { core, words, address } = rig();
		const slots = 40;
		const order = Array.from({ length: slots }, (_, i) => i * 7 + 3);
		type Entry = { slot: number; word: number; deadline: bigint };
		const armed = new Map<number, Entry>();
		let state = 12345;
		const rand = (n: number) => {
			state = (Math.imul(state, 1103515245) + 12345) >>> 0;
			return (state >>> 8) % n;
		};
		const walk = (now: bigint) =>
			[...armed.values()]
				.sort((a, b) => order[a.slot]! - order[b.slot]!)
				.find((e) => words[e.word]! !== 0n || (e.deadline >= 0n && e.deadline <= now));
		for (let step = 0; step < 20_000; step++) {
			const op = rand(10);
			if (op < 4) {
				const slot = rand(slots);
				const word = rand(16);
				const deadline = rand(3) === 0 ? -1n : BigInt(rand(500));
				armed.set(slot, { slot, word, deadline });
				expect(core.core_idle(slot, order[slot]!, address(word), deadline)).toBe(0);
			} else if (op < 5) {
				const slot = rand(slots);
				expect(core.core_cancel(slot)).toBe(armed.delete(slot) ? 1 : 0);
			} else if (op < 7) {
				words[rand(16)] = BigInt(rand(2));
			} else if (op < 9) {
				const now = BigInt(rand(600));
				const want = walk(now);
				if (want) armed.delete(want.slot);
				expect(core.core_pick(now)).toBe(want ? want.slot : -1);
			} else {
				const soonest = [...armed.values()]
					.filter((e) => e.deadline >= 0n)
					.reduce((m, e) => (m < 0n || e.deadline < m ? e.deadline : m), -1n);
				expect(core.core_deadline()).toBe(soonest);
			}
			expect(core.core_idle_count()).toBe(armed.size);
		}
	});

	it('refuses a base that is not 16-byte aligned', () => {
		const memory = new WebAssembly.Memory({ initial: 4, maximum: 64, shared: true });
		expect(() => loadCore(built, memory, 0x10003)).toThrow(/aligned/);
	});

	it('writes only into the pages reserved for it', () => {
		const { core, memory, base, address } = rig();
		const before = new Uint8Array(memory.buffer).slice(0, base);
		for (let slot = 0; slot < 200; slot++)
			core.core_idle(slot, slot, address(slot % 16), BigInt(slot));
		for (let i = 0; i < 1000; i++) core.core_ready_push(i);
		expect(new Uint8Array(memory.buffer).slice(0, base)).toEqual(before);
	});
});

const PARK_IMPORTS = [
	'wasm_serialize_tasks',
	'wasm_create_and_run_task',
	'wasm_idle_wait',
	'wasm_cpu_relax',
	'wasm_halt',
	'wasm_user_mode_tail'
];

/** tests/fixtures/toy-kernel.wat, asyncified as tests/unit/machine.test.ts builds it */
function toyKernel(): WebAssembly.Module {
	const toy = binaryen.parseText(
		readFileSync(new URL('../fixtures/toy-kernel.wat', import.meta.url), 'utf8')
	);
	toy.setFeatures(
		binaryen.Features.Atomics |
			binaryen.Features.MutableGlobals |
			binaryen.Features.BulkMemory |
			binaryen.Features.BulkMemoryOpt
	);
	binaryen.setPassArgument('asyncify-imports', PARK_IMPORTS.map((n) => `env.${n}`).join(','));
	toy.runPasses(['asyncify']);
	const bytes = toy.emitBinary();
	toy.dispose();
	return new WebAssembly.Module(bytes);
}

describe('the idle tables of a machine', () => {
	const empty = () => new WebAssembly.Module(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));

	for (const arm of ['TypeScript', 'C core'] as const) {
		it(`pick like a walk of the runners over random waits, words and clocks (${arm})`, () => {
			let clock = 0n;
			const machine: any = new Machine({
				vmlinux: empty(),
				initrd: new Uint8Array(0),
				cmdline: '',
				registry: new Map(),
				sha256: () => '',
				maximumPages: 64,
				now: () => clock,
				...(arm === 'C core' ? { core: built } : {})
			});
			if (arm === 'C core') machine.startCore(machine.memory.grow(1) * 0x10000);
			const count = 48;
			const runners = Array.from({ length: count }, (_, i) => {
				const runner = machine.runner(`r${i}`, { kind: 'boot' });
				runner.id = 0x100000 + i * 0x800;
				machine.runners.set(runner.id, runner);
				return runner;
			});
			const words = new Int32Array(machine.memory.buffer, WORDS, 32);
			let state = 99;
			const rand = (n: number) => {
				state = (Math.imul(state, 1103515245) + 12345) >>> 0;
				return (state >>> 8) % n;
			};
			const armed = new Set<number>();
			let woken = 0;
			const want = () =>
				[...armed]
					.sort((a, b) => a - b)
					.find((i) => {
						const idle = runners[i].idle;
						const at = (idle.word - WORDS) >> 2;
						return (
							words[at] !== 0 ||
							words[at + 1] !== 0 ||
							(idle.deadline >= 0n && idle.deadline <= clock)
						);
					});
			for (let step = 0; step < 30_000; step++) {
				const op = rand(12);
				if (op < 5) {
					const i = rand(count);
					const deadline = rand(3) === 0 ? -1n : clock + BigInt(rand(400)) - 50n;
					machine.arm(runners[i], WORDS + rand(16) * 8, deadline);
					armed.add(i);
				} else if (op < 6) {
					const i = rand(count);
					machine.unindex(runners[i]);
					armed.delete(i);
				} else if (op < 8) {
					words[rand(16) * 2] = rand(2);
				} else if (op < 10) {
					clock += BigInt(rand(60));
					const expected = want();
					const picked = machine.pickIdle();
					expect(picked ? runners.indexOf(picked) : undefined).toBe(expected);
					if (expected !== undefined) {
						armed.delete(expected);
						woken++;
					}
					expect(picked?.idle ?? null).toBeNull();
				} else {
					const soonest = [...armed]
						.map((i) => runners[i].idle.deadline as bigint)
						.filter((d) => d >= 0n)
						.reduce<bigint | null>((m, d) => (m === null || d < m ? d : m), null);
					expect(machine.nextDeadline()).toBe(soonest);
				}
			}
			expect(woken).toBeGreaterThan(1000);
		});
	}
});

describe('a machine with the core', () => {
	function session(extra: Partial<MachineOptions>) {
		const clock = { ns: 0n };
		let output = '';
		const options: MachineOptions = {
			vmlinux: toyKernel(),
			initrd: new Uint8Array(16),
			cmdline: 'toy',
			registry: new Map(),
			maximumPages: 64,
			sha256: (bytes) => String.fromCharCode(bytes[0] ?? 0),
			now: () => clock.ns,
			write: (text) => (output += text),
			router: routerModules(),
			asyncify: true,
			sharedKernel: true,
			...extra
		};
		const sleep = async (ms: number) => {
			clock.ns += BigInt(Math.max(ms, 1)) * 1_000_000n;
		};
		const run = (machine: Machine, until: () => boolean) => machine.run(until, sleep, 20_000);
		return { options, run, output: () => output };
	}

	it('boots, forks and switches like the TypeScript tables, with the same counters', async () => {
		const runs = [];
		for (const core of [undefined, built]) {
			const s = session({ core });
			const machine = new Machine(s.options);
			await s.run(machine, () => s.output().includes('parent ok'));
			machine.type('s');
			await s.run(machine, () => s.output().includes('parent back ok'));
			const { switches, idles, relaxes, runners } = machine.stats;
			runs.push({ out: s.output(), switches, idles, relaxes, runners, d: machine.deadline });
		}
		expect(runs[1]).toEqual(runs[0]);
		expect(runs[0]!.out).toContain('echo:schild ok\nparent back ok\n');
	});

	it('checkpoints with its region recorded and restores with its idle cpus armed again', async () => {
		const s = session({ core: built });
		const machine = new Machine(s.options);
		await s.run(machine, () => s.output().includes('parent ok'));
		const snapshot = await machine.checkpoint();
		expect(snapshot.core).toBeGreaterThan(0);
		const restored = await Machine.restore(s.options, snapshot);
		restored.type('s');
		await s.run(restored, () => s.output().includes('parent back ok'));
		expect(s.output()).toContain('echo:schild ok\nparent back ok\n');
		restored.type('q');
		expect(await s.run(restored, () => false)).toBe('halted');
	});

	it('refuses to restore a snapshot that has no core region', async () => {
		const s = session({});
		const machine = new Machine(s.options);
		await s.run(machine, () => s.output().includes('parent ok'));
		const snapshot = await machine.checkpoint();
		await expect(Machine.restore({ ...s.options, core: built }, snapshot)).rejects.toThrow(
			/no core region/
		);
	});
});
