import { coreRegionPages, loadCore } from '../../../src/worker/machine/core.ts';
import coreModule from './gmux-core.wasm';

/**
 * Loads gmux-core.wasm as a bundled static module over a shared memory, as the machine does, and
 * answers whether its scheduler decides as expected: GET / returns `{ ok: true, ... }`
 */
export default {
	async fetch(): Promise<Response> {
		const memory = new WebAssembly.Memory({ initial: 2, maximum: 64, shared: true });
		const base = memory.grow(coreRegionPages(coreModule)) * 0x10000;
		const core = loadCore(coreModule, memory, base);
		const words = new BigInt64Array(memory.buffer, 0x1000, 4);
		core.core_idle(1, 20, 0x1000, -1n);
		core.core_idle(2, 10, 0x1008, 50n);
		core.core_idle(3, 30, 0x1010, 10n);
		const quiet = core.core_pick(5n);
		const deadline = core.core_deadline();
		const timer = core.core_pick(10n);
		words[0] = 1n;
		words[1] = 1n;
		const raised = [core.core_pick(10n), core.core_pick(10n), core.core_pick(10n)];
		core.core_ready_push(4);
		core.core_ready_unshift(5);
		const ready = [core.core_ready_shift(), core.core_ready_shift(), core.core_ready_shift()];
		const result = {
			version: core.core_version(),
			quiet,
			deadline: String(deadline),
			timer,
			raised,
			ready
		};
		const ok =
			result.version === 1 &&
			quiet === -1 &&
			result.deadline === '10' &&
			timer === 3 &&
			raised.join() === '2,1,-1' &&
			ready.join() === '5,4,-1';
		return Response.json({ ok, ...result }, { status: ok ? 200 : 500 });
	}
};
