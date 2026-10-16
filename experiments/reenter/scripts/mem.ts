import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openRung } from './link.ts';

/**
 * One fresh process per arm: what the guest costs in memory when the interpreter and a native module share its bytes or
 * each hold their own, counting the process's own peak so the two ledgers are not added by hand.
 *
 * `mem.ts <closed ladder dir> <arm> <wasm3.wasm | -> [out.json]`, where the ladder dir holds `guest.wasm` and the all-native
 * rung (rung 1); arms: `orig` (the unsplit module in V8), `base-form` (wasm3's own memory holds the guest, the native module
 * over it at an offset) and `shared` (the guest memory build: the guest's bytes in the one shared Memory, the native module at
 * base 0). RSS is read before instantiating, after, and after one `run(1)`; `maxRssKiB` is the process's peak (kernel high-water
 * mark, so it also covers the compile).
 */
const [dir = '', arm = '', wasm3 = '-', out = ''] = process.argv.slice(2);
if (!dir || !['orig', 'base-form', 'shared'].includes(arm)) throw new Error('usage: mem.ts <closed ladder dir> <orig | base-form | shared> <wasm3.wasm | -> [out.json]');

const rss = () => process.memoryUsage().rss;
const guestBytes = new Uint8Array(readFileSync(join(dir, 'guest.wasm')));
const before = rss();
let run: (n: number) => number;
let wasm3Memory = 0;
let sharedMemory = 0;
let nativeModule = 0;
if (arm === 'orig') {
	const inst = new WebAssembly.Instance(new WebAssembly.Module(guestBytes)).exports as { run: (n: number) => number; memory: WebAssembly.Memory };
	run = inst.run;
	sharedMemory = inst.memory.buffer.byteLength;
} else {
	const rungs = JSON.parse(readFileSync(join(dir, 'rungs.json'), 'utf8')) as { rungs: { rung: number; label: string; imports: Record<string, string> }[] };
	const rung = rungs.rungs.at(-1)!;
	if (rung.label !== 'native') throw new Error(`the last rung is ${rung.label}`);
	const { vm, linked } = await openRung(wasm3, dir, rung, 'glued');
	run = (n) => linked.guest.call('run', n);
	wasm3Memory = vm.shim.memory.buffer.byteLength;
	sharedMemory = vm.guest ? vm.guest.buffer.byteLength : 0;
	nativeModule = statSync(join(dir, `rung${rung.rung}.native.wasm`)).size;
}
const afterInstantiate = rss();
run(1);
const afterRun = rss();
const row = {
	arm,
	platform: process.platform,
	rssBefore: before,
	rssAfterInstantiate: afterInstantiate,
	rssAfterRun: afterRun,
	maxRssRaw: process.resourceUsage().maxRSS,
	guestModuleBytes: guestBytes.length,
	wasm3MemoryBytes: wasm3Memory,
	sharedMemoryBytes: sharedMemory,
	nativeModuleBytes: nativeModule
};
if (out) writeFileSync(out, JSON.stringify(row));
else console.log(JSON.stringify(row));
