// resume check: build/resume-test.evac.wasm (evacuate.mjs --resume) checkpointed at tick k, restored
// into a fresh instance and resumed, must print what the plain build prints; each case also takes a
// second checkpoint inside the resumed run. `node resume-test.mjs [n]`
import { readFileSync } from 'node:fs';

const n = Number(process.argv[2] ?? 6);
const plain = new WebAssembly.Module(readFileSync(new URL('../build/resume-test.wasm', import.meta.url)));
const evac = new WebAssembly.Module(readFileSync(new URL('../build/resume-test.evac.wasm', import.meta.url)));

function instance(module, out, onTick) {
	const box = {};
	box.i = new WebAssembly.Instance(module, {
		env: { out: (v) => out.push(v), tick: () => onTick(box.i) }
	});
	return box.i;
}

const refOut = [];
let refTicks = 0;
const refResult = instance(plain, refOut, () => refTicks++).exports.run(n);
const noCkpt = [];
const evacResult = instance(evac, noCkpt, () => {}).exports.run(n);
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
if (!same(noCkpt, refOut) || evacResult !== refResult) throw new Error('the evacuable build differs without a checkpoint');

/** runs until tick `at`, evacuates, and returns the snapshot, or null if the run finished first */
function checkpoint(start, out, at) {
	let ticks = 0;
	const inst = instance(evac, out, (i) => {
		if (++ticks !== at) return;
		i.exports.gmux_fp.value = i.exports.memory.grow(1) * 0x10000;
		throw new WebAssembly.Exception(i.exports.gmux_ckpt, []);
	});
	try {
		return { done: start(inst) };
	} catch (e) {
		if (!(e instanceof WebAssembly.Exception) || !e.is(inst.exports.gmux_ckpt)) throw e;
		return {
			memory: new Uint8Array(inst.exports.memory.buffer).slice(),
			sp: inst.exports.__stack_pointer.value,
			fp: inst.exports.gmux_fp.value
		};
	}
}

function restore(snap) {
	return (inst) => {
		const mem = inst.exports.memory;
		mem.grow(snap.memory.byteLength / 0x10000 - mem.buffer.byteLength / 0x10000);
		new Uint8Array(mem.buffer).set(snap.memory);
		inst.exports.__stack_pointer.value = snap.sp;
		inst.exports.gmux_fp.value = snap.fp;
		return inst.exports['run$resume']();
	};
}

const points = [...new Set([1, 2, 3, 5, 17, 64, 100, Math.floor(refTicks / 3), Math.floor(refTicks / 2), refTicks - 1, refTicks])].filter((k) => k >= 1 && k <= refTicks);
let pass = 0;
for (const k of points) {
	const out = [];
	const first = checkpoint((i) => i.exports.run(n), out, k);
	if (first.done !== undefined) throw new Error(`tick ${k}: no checkpoint`);
	// the resumed innermost frame calls tick again, so the second checkpoint counts from there
	const second = checkpoint(restore(first), out, Math.max(2, Math.floor((refTicks - k) / 2)));
	const result = second.done !== undefined ? second.done : checkpoint(restore(second), out, 0).done;
	const ok = same(out, refOut) && result === refResult;
	if (ok) pass++;
	console.log(ok ? 'PASS' : 'FAIL', `checkpoint at tick ${k} of ${refTicks}${second.done !== undefined ? ' (finished before a second)' : ', then again'}`, ok ? '' : JSON.stringify({ got: out.slice(-3).map(String), want: refOut.slice(-3).map(String), result: String(result), refResult: String(refResult) }));
}
console.log(`${pass}/${points.length}`);
process.exit(pass === points.length ? 0 : 1);
