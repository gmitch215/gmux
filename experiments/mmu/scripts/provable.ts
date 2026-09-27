import binaryen from 'binaryen';
import { readFileSync, writeFileSync } from 'node:fs';

/**
 * How many of a program's checked accesses an owner check could cover from outside the access itself.
 * Each load and store (atomics, SIMD and bulk memory included) is classed by its address: a local
 * plus a constant (its base), or computed. A base is `stack` when every write to it is the stack
 * pointer plus or minus a constant (the stack pass bounds the pointer at each frame), `fn` when every write to it sits outside all
 * loops (a parameter, the stack pointer copy), `loop` when its innermost loop never writes it, `var`
 * otherwise. An access is `shared` when an earlier access in the same straight run (no call, branch,
 * `if` or loop head between, the base unwritten) used the same base within 4,080 bytes, so one range
 * check covers both. The rewritten module counts each class as it runs, beside the checks a hoisted
 * form would run instead (`hoistFn`: function entries and writes of `fn` bases; `hoistLoop`: loop
 * entries for `loop` bases; `epoch`: one generation compare per iteration per hoisted base used in
 * the loop), and for `var` and computed accesses how often a site's page equals its last (`cache*`:
 * a per-site cache that outlives the call; `frame*`: one that lives in the frame, as a local would;
 * neither revalidated, since resumes are rare against accesses). The counters are exported i64
 * globals named `gmux_n_<counter>`.
 * `node --experimental-strip-types provable.ts <in.wasm> <out.wasm>`
 */
const [input, output] = process.argv.slice(2);
const E = binaryen;
const F = binaryen.Features;
const module = binaryen.readBinary(readFileSync(input!));
module.setFeatures(
	F.MVP |
		F.Atomics |
		F.MutableGlobals |
		F.BulkMemory |
		F.BulkMemoryOpt |
		F.SignExt |
		F.NontrappingFPToInt |
		F.SIMD128 |
		F.ExceptionHandling |
		F.Multivalue |
		F.CallIndirectOverlong |
		F.ReferenceTypes
);

const names = [
	'loads',
	'stores',
	'bulk',
	'stackShared',
	'stackOwn',
	'fnShared',
	'fnOwn',
	'loopShared',
	'loopOwn',
	'varShared',
	'varOwn',
	'computed',
	'hoistFn',
	'hoistLoop',
	'epoch',
	'cacheVar',
	'cacheComputed',
	'frameVar',
	'frameComputed'
] as const;
type Counter = (typeof names)[number];
for (const n of names) {
	module.addGlobal(`gmux_n_${n}`, E.i64, true, module.i64.const(0n));
	module.addGlobalExport(`gmux_n_${n}`, `gmux_n_${n}`);
}
module.addGlobal('gmux_t', E.i32, true, module.i32.const(0));
module.addGlobal('gmux_call', E.i32, true, module.i32.const(0));
const add = (n: Counter, by = 1) =>
	module.global.set(
		`gmux_n_${n}`,
		module.i64.add(module.global.get(`gmux_n_${n}`, E.i64), module.i64.const(BigInt(by)))
	);
let sites = 0;
const statics: Record<string, number> = {};
const bump = (k: string) => (statics[k] = (statics[k] ?? 0) + 1);

let stackPointer = '';
for (let g = 0; g < module.getNumGlobals(); g++) {
	const info = E.getGlobalInfo(module.getGlobalByIndex(g));
	if (info.base === '__stack_pointer' || info.name === '__stack_pointer') stackPointer = info.name;
}
// binaryen.js has no info getters for a few ids (none of them touch memory)
const infoOf = (e: number): any => {
	try {
		return E.getExpressionInfo(e);
	} catch {
		bump(`noInfo${E.getExpressionId(e)}`);
		return { id: E.getExpressionId(e) };
	}
};
// a loop under an operand cannot get a block around it; counted so the hoistLoop total's gap is known
const miss = () => bump('loopEntryMissed');
const children = (e: number): [number, (x: number) => void][] => {
	const i = infoOf(e);
	const kids: [number, (x: number) => void][] = [];
	const put = (v: number, set: (x: number) => void) => v && kids.push([v, set]);
	switch (i.id) {
		case E.BlockId:
			i.children.forEach((c: number, k: number) => put(c, (x) => E.Block.setChildAt(e, k, x)));
			break;
		case E.IfId:
			put(i.condition, (x) => E.If.setCondition(e, x));
			put(i.ifTrue, (x) => E.If.setIfTrue(e, x));
			put(i.ifFalse, (x) => E.If.setIfFalse(e, x));
			break;
		case E.LoopId:
			put(i.body, (x) => E.Loop.setBody(e, x));
			break;
		case E.TryId:
			put(i.body, (x) => E.Try.setBody(e, x));
			i.catchBodies.forEach((c: number, k: number) => put(c, (x) => E.Try.setCatchBodyAt(e, k, x)));
			break;
		default:
			// operands: order is evaluation order; setters are not needed below an expression
			for (const k of [
				'condition',
				'value',
				'operands',
				'target',
				'ptr',
				'expected',
				'replacement',
				'timeout',
				'notifyCount',
				'left',
				'right',
				'ifTrue',
				'ifFalse',
				'vec',
				'shift',
				'a',
				'b',
				'c',
				'dest',
				'source',
				'offset',
				'size',
				'delta',
				'tuple',
				'ref'
			]) {
				const v = i[k];
				if (k === 'value' && i.id === E.ConstId) continue;
				if (k === 'offset' && i.id !== E.MemoryInitId) continue;
				if (Array.isArray(v)) v.forEach((c: number) => put(c, miss));
				else if (typeof v === 'number' && v) put(v, miss);
			}
	}
	return kids;
};
const isAccess = (id: number) =>
	[
		E.LoadId,
		E.StoreId,
		E.AtomicRMWId,
		E.AtomicCmpxchgId,
		E.AtomicWaitId,
		E.AtomicNotifyId,
		E.SIMDLoadId,
		E.SIMDLoadStoreLaneId
	].includes(id);
const setPtr = (e: number, id: number, p: number) =>
	(
		({
			[E.LoadId]: E.Load,
			[E.StoreId]: E.Store,
			[E.AtomicRMWId]: E.AtomicRMW,
			[E.AtomicCmpxchgId]: E.AtomicCmpxchg,
			[E.AtomicWaitId]: E.AtomicWait,
			[E.AtomicNotifyId]: E.AtomicNotify,
			[E.SIMDLoadId]: E.SIMDLoad,
			[E.SIMDLoadStoreLaneId]: E.SIMDLoadStoreLane
		}) as any
	)[id].setPtr(e, p);
/** the base local and constant of an address, or null when it is computed */
const baseOf = (ptr: number, offset: number): [number, number] | null => {
	const i = infoOf(ptr);
	if (i.id === E.LocalGetId) return [i.index, offset];
	if (i.id === E.BinaryId && i.op === E.AddInt32) {
		const l = infoOf(i.left);
		const r = infoOf(i.right);
		if (l.id === E.LocalGetId && r.id === E.ConstId) return [l.index, offset + r.value];
		if (r.id === E.LocalGetId && l.id === E.ConstId) return [r.index, offset + l.value];
	}
	return null;
};

for (let f = 0; f < module.getNumFunctions(); f++) {
	const fn = module.getFunctionByIndex(f);
	const info = E.getFunctionInfo(fn);
	if (!info.body) continue;
	// every write of each local, and the loops around it
	const writesIn = new Map<number, number[][]>();
	const stackWrites = new Map<number, number>();
	const isStack = (v: number): boolean => {
		const i = infoOf(v);
		if (i.id === E.GlobalGetId) return i.name === stackPointer;
		if (i.id === E.BinaryId && (i.op === E.SubInt32 || i.op === E.AddInt32))
			return isStack(i.left) && infoOf(i.right).id === E.ConstId;
		return false;
	};
	const scan = (e: number, loops: number[]) => {
		const i = infoOf(e);
		if (i.id === E.LocalSetId) {
			(writesIn.get(i.index) ?? writesIn.set(i.index, []).get(i.index)!).push(loops);
			if (isStack(i.value)) stackWrites.set(i.index, (stackWrites.get(i.index) ?? 0) + 1);
		}
		const inner = i.id === E.LoopId ? [...loops, e] : loops;
		for (const [c] of children(e)) scan(c, inner);
	};
	scan(info.body, []);
	const writes = (x: number) => writesIn.get(x) ?? [];
	const fnBase = (x: number) => writes(x).every((loops) => loops.length === 0);
	// a base every write of which is the stack pointer, or it plus or minus a constant
	const stackBase = (x: number) => (stackWrites.get(x) ?? 0) > 0 && stackWrites.get(x) === writes(x).length;
	const unwrittenIn = (x: number, loop: number) => writes(x).every((loops) => !loops.includes(loop));
	const fnBases = new Set<number>();
	const loopBases = new Map<number, Set<number>>();
	const iterBases = new Map<number, Set<number>>();
	// this call's id, for the frame-local cache
	let frame = -1;
	// the bases proven in the current straight run: base -> [low, high) of offsets
	let run = new Map<number, [number, number]>();
	const walk = (e: number, loops: number[]) => {
		const i = infoOf(e);
		const id = i.id;
		if (id === E.LoopId || id === E.IfId || id === E.TryId || id === E.CallId || id === E.CallIndirectId || id === E.BreakId || id === E.SwitchId || id === E.ReturnId || id === E.ThrowId || id === E.RethrowId || id === E.UnreachableId) {
			// operands of a call run before it, so walk them first
			if (id !== E.LoopId && id !== E.IfId && id !== E.TryId)
				for (const [c] of children(e)) walk(c, loops);
			else if (id === E.IfId) walk(i.condition, loops);
			run = new Map();
			if (id === E.LoopId) walk(i.body, [...loops, e]);
			if (id === E.IfId) {
				walk(i.ifTrue, loops);
				run = new Map();
				if (i.ifFalse) walk(i.ifFalse, loops);
			}
			if (id === E.TryId) for (const [c] of children(e)) (walk(c, loops), (run = new Map()));
			run = new Map();
			return;
		}
		for (const [c] of children(e)) walk(c, loops);
		if (id === E.LocalSetId) run.delete(i.index);
		if (id === E.MemoryCopyId || id === E.MemoryFillId) {
			bump('bulk');
			// the operands are already walked; count the call by wrapping the size
			const set = id === E.MemoryCopyId ? E.MemoryCopy.setSize : E.MemoryFill.setSize;
			set(e, module.block(null, [add('bulk'), i.size], E.i32));
			return;
		}
		if (!isAccess(id)) return;
		const writesMem = id === E.StoreId || id === E.AtomicRMWId || id === E.AtomicCmpxchgId || (id === E.SIMDLoadStoreLaneId && i.isStore);
		const bytes = i.bytes ?? 16;
		const base = baseOf(i.ptr, i.offset ?? 0);
		const counters: Counter[] = [writesMem ? 'stores' : 'loads'];
		let cache: Counter | null = null;
		if (!base) {
			counters.push('computed');
			cache = 'cacheComputed';
		} else {
			const [x, off] = base;
			const inner = loops[loops.length - 1];
			const kind = stackBase(x) ? 'stack' : fnBase(x) ? 'fn' : inner && unwrittenIn(x, inner) ? 'loop' : 'var';
			const seen = run.get(x);
			const shared = seen && Math.max(seen[1], off + bytes) - Math.min(seen[0], off) <= 4080;
			run.set(x, seen && shared ? [Math.min(seen[0], off), Math.max(seen[1], off + bytes)] : [off, off + bytes]);
			counters.push(`${kind}${shared ? 'Shared' : 'Own'}` as Counter);
			if (kind === 'fn') fnBases.add(x);
			if (kind === 'loop') (loopBases.get(inner!) ?? loopBases.set(inner!, new Set()).get(inner!)!).add(x);
			if ((kind === 'fn' || kind === 'loop') && inner) (iterBases.get(inner) ?? iterBases.set(inner, new Set()).get(inner)!).add(x);
			if (kind === 'var' && !shared) cache = 'cacheVar';
		}
		for (const c of counters) bump(c);
		const incs = counters.map((c) => add(c));
		if (!cache) setPtr(e, id, module.block(null, [...incs, i.ptr], E.i32));
		else {
			const last = `gmux_s${sites++}`;
			module.addGlobal(last, E.i32, true, module.i32.const(-1));
			module.addGlobal(`${last}c`, E.i32, true, module.i32.const(-1));
			if (frame < 0) frame = E._BinaryenFunctionAddVar(fn, E.i32);
			const page = () =>
				module.i32.shr_u(
					module.i32.add(module.global.get('gmux_t', E.i32), module.i32.const(i.offset ?? 0)),
					module.i32.const(12)
				);
			setPtr(
				e,
				id,
				module.block(
					null,
					[
						...incs,
						module.global.set('gmux_t', i.ptr),
						module.if(
							module.i32.eq(page(), module.global.get(last, E.i32)),
							module.block(null, [
								add(cache),
								module.if(
									module.i32.eq(module.local.get(frame, E.i32), module.global.get(`${last}c`, E.i32)),
									add(cache === 'cacheVar' ? 'frameVar' : 'frameComputed')
								)
							])
						),
						module.global.set(last, page()),
						module.global.set(`${last}c`, module.local.get(frame, E.i32)),
						module.global.get('gmux_t', E.i32)
					],
					E.i32
				)
			);
		}
	};
	walk(info.body, []);
	// hoisted checks: a function's entry for bases it never writes, each write for the rest of its
	// fn bases (outside loops, so once a call at most), a loop's entry, a generation compare per
	// iteration
	const params = binaryen.expandType(info.params).length;
	const entry = [...fnBases].filter((x) => x < params || writes(x).length === 0).length;
	const place = (e: number, loops: number[], set: (x: number) => void) => {
		const i = infoOf(e);
		if (i.id === E.LocalSetId && fnBases.has(i.index) && loops.length === 0)
			E.LocalSet.setValue(e, module.block(null, [add('hoistFn'), i.value], E.getExpressionType(i.value)));
		const inner = i.id === E.LoopId ? [...loops, e] : loops;
		for (const [c, s] of children(e)) place(c, inner, s);
		if (i.id === E.LoopId) {
			const hoisted = loopBases.get(e)?.size ?? 0;
			const iter = iterBases.get(e)?.size ?? 0;
			if (iter) E.Loop.setBody(e, module.block(null, [add('epoch', iter), i.body], E.getExpressionType(i.body)));
			if (hoisted) set(module.block(null, [add('hoistLoop', hoisted), e], i.type));
		}
	};
	place(info.body, [], miss);
	const prologue = entry ? [add('hoistFn', entry)] : [];
	if (frame >= 0)
		prologue.push(
			module.global.set('gmux_call', module.i32.add(module.global.get('gmux_call', E.i32), module.i32.const(1))),
			module.local.set(frame, module.global.get('gmux_call', E.i32))
		);
	if (prologue.length) E.Function.setBody(fn, module.block(null, [...prologue, E.getFunctionInfo(fn).body], info.results));
}
if (!module.validate()) throw new Error('invalid module');
writeFileSync(output!, module.emitBinary());
console.log(JSON.stringify({ sites, ...statics }));
