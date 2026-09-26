// Cold Stack Evacuation on a real program. Unwind: after binaryen's flatten (every value a local),
// each call statement that can reach a safepoint gets a try whose catch of $gmux.ckpt writes the
// frame's locals and a resume id at $gmux.fp and rethrows. Resume (--resume): each such function F
// gets F$resume, which pops its frame and runs a copy of F peeled along the path to the recorded call:
// a block resumes inside its child and runs the siblings after it, a loop runs the rest of the current
// iteration and then an unmodified copy of itself, and the call is re-issued to the callee's
// F$resume (an import is called again). Normal execution never enters a variant.
// `node evacuate.mjs in.wasm out.wasm [--no-handlers] [--resume]`; without handlers it is the same
// flatten and -O2, the baseline that isolates the handlers' cost
import binaryen from 'binaryen';
import { readFileSync, writeFileSync } from 'node:fs';

const [input, output, ...flags] = process.argv.slice(2);
const handlers = !flags.includes('--no-handlers');
const resume = flags.includes('--resume');
// measurement arm: one try per function, the current site kept in a local (no resume variants yet)
const oneTry = flags.includes('--one-try');
// measurement arm: handlers that save no locals, the bound on what spilling fewer of them can gain
const noSpill = flags.includes('--no-spill');
// measurement arm: spill every local, as before liveness
const allLocals = flags.includes('--all-locals');
// measurement arm: no handlers at fuel yields (the loop back edges' safepoints), to price them
const noFuelSites = flags.includes('--no-fuel-sites');
const F = binaryen.Features;
const features =
	F.MVP | F.Atomics | F.MutableGlobals | F.BulkMemory | F.BulkMemoryOpt | F.SignExt | F.NontrappingFPToInt | F.SIMD128 | F.ExceptionHandling | F.Multivalue | F.CallIndirectOverlong | F.ReferenceTypes;
const module = binaryen.readBinary(readFileSync(input));
module.setFeatures(features);
// flat, then locals coalesced while still flat: a handler spills every local of its function, which
// keeps them all live across the call, so there must be few of them before handlers go in
module.runPasses(['flatten', 'simplify-locals-nonesting', 'coalesce-locals', 'reorder-locals', 'vacuum']);

// a checkpoint is only thrown at a safepoint, which is an import (a syscall, a fuel yield), so a call
// needs a handler only if its callee can reach an import. An indirect call can land only on a table
// function of its own signature, so it reaches one only if such a function does
const reaches = new Set();
const imports = new Set();
// a function import other than the host's own calls is another module's function (a side module
// calling into the program): it is assumed to reach a safepoint, and resumes through its name$resume
const foreign = new Map();
// a side module (no _start) shares the program's unwind state and resume table instead of its own
let side = true;
for (let e = 0; e < module.getNumExports(); e++) if (binaryen.getExportInfo(module.getExportByIndex(e)).name === '_start') side = false;
/** the signatures some table function reaching a safepoint has, as "params:results" */
const reachingSignatures = new Set();
// a table other modules put functions in (a side module's, a program's that dlopens): an indirect call
// can land on code this module cannot see, so any of them may reach a safepoint
let loadsLibraries = false;
const indirectReaches = (key) => side || loadsLibraries || reachingSignatures.has(key);
const signature = (params, results) => `${params}:${results}`;
{
	const text = module.emitText();
	for (const m of text.matchAll(/\(import "([^"]*)" "([^"]*)" \(func \$([^\s)]+)/g)) {
		if (!(noFuelSites && m[2] === '__gmux_fuel')) imports.add(m[3]);
		if (m[1] === 'env' && !/^__(wasm|gmux)_/.test(m[2])) foreign.set(m[3], m[2]);
		if (m[2] === '__gmux_dlopen') loadsLibraries = true;
	}
	// a text type name to its signature, through the functions declared with it
	const typeKey = new Map();
	for (const m of text.matchAll(/\n \(func \$([^\s)]+) \(type \$([^\s)]+)\)/g)) {
		const info = binaryen.getFunctionInfo(module.getFunction(m[1]));
		typeKey.set(m[2], signature(info.params, info.results));
	}
	const table = new Set();
	for (let i = 0; i < module.getNumElementSegments(); i++)
		for (const name of binaryen.getElementSegmentInfo(module.getElementSegmentByIndex(i)).data) table.add(name);
	const keyOf = (name) => {
		const info = binaryen.getFunctionInfo(module.getFunction(name));
		return signature(info.params, info.results);
	};
	const callees = new Map();
	const indirect = new Map();
	for (const m of text.matchAll(/\n \(func \$([^\s)]+)([\s\S]*?)(?=\n \(func |\n \(export |\n \(elem |\n \(data |\n \(tag |\n\)\s*$)/g)) {
		const body = m[2];
		const calls = [...body.matchAll(/\(call \$([^\s)]+)/g)].map((c) => c[1]);
		const types = [...body.matchAll(/\(call_indirect \$[^\s)]+ \(type \$([^\s)]+)\)/g)].map((c) => typeKey.get(c[1]));
		if (calls.some((c) => imports.has(c))) reaches.add(m[1]);
		callees.set(m[1], calls);
		indirect.set(m[1], types);
	}
	for (const name of imports) reaches.add(name);
	for (let changed = true; changed; ) {
		changed = false;
		for (const name of table)
			if (reaches.has(name) && !reachingSignatures.has(keyOf(name))) reachingSignatures.add(keyOf(name)), (changed = true);
		for (const [fn, calls] of callees)
			if (!reaches.has(fn) && (calls.some((c) => reaches.has(c)) || indirect.get(fn).some((k) => indirectReaches(k))))
				reaches.add(fn), (changed = true);
	}
}
const { i32, i64, f32, f64, v128, none, unreachable } = binaryen;
const size = { [i32]: 4, [i64]: 8, [f32]: 4, [f64]: 8, [v128]: 16 };
const E = binaryen;

/** the locals an expression reads; null for an expression it does not know (read everything) */
function reads(expr, into) {
	if (!expr) return into;
	const id = E.getExpressionId(expr);
	let info;
	try {
		info = E.getExpressionInfo(expr);
	} catch {
		return null;
	}
	const sub = (...xs) => { for (const x of xs) if (x) reads(x, into); };
	switch (id) {
		case E.LocalGetId: into.add(info.index); break;
		case E.ConstId: case E.GlobalGetId: case E.NopId: case E.UnreachableId: case E.MemorySizeId: case E.PopId: break;
		case E.LocalSetId: case E.GlobalSetId: case E.DropId: case E.ReturnId: case E.UnaryId: case E.MemoryGrowId: sub(info.value ?? info.delta); break;
		case E.BinaryId: sub(info.left, info.right); break;
		case E.SelectId: sub(info.ifTrue, info.ifFalse, info.condition); break;
		case E.LoadId: sub(info.ptr); break;
		case E.StoreId: sub(info.ptr, info.value); break;
		case E.CallId: sub(...info.operands); break;
		case E.CallIndirectId: sub(info.target, ...info.operands); break;
		case E.AtomicRMWId: sub(info.ptr, info.value); break;
		case E.AtomicCmpxchgId: sub(info.ptr, info.expected, info.replacement); break;
		case E.AtomicWaitId: sub(info.ptr, info.expected, info.timeout); break;
		case E.AtomicNotifyId: sub(info.ptr, info.notifyCount); break;
		case E.SIMDExtractId: sub(info.vec); break;
		case E.SIMDReplaceId: sub(info.vec, info.value); break;
		case E.SIMDShuffleId: sub(info.left, info.right); break;
		case E.SIMDTernaryId: sub(info.a, info.b, info.c); break;
		case E.SIMDShiftId: sub(info.vec, info.shift); break;
		case E.SIMDLoadId: sub(info.ptr); break;
		case E.SIMDLoadStoreLaneId: sub(info.ptr, info.vec); break;
		case E.MemoryCopyId: sub(info.dest, info.source, info.size); break;
		case E.MemoryFillId: sub(info.dest, info.value, info.size); break;
		case E.ThrowId: sub(...info.operands); break;
		default: return null;
	}
	return into;
}

/**
 * backward liveness over flat structured IR: for each call statement, the locals live once it returns.
 * Branches take their target's live set (a block's exit, a loop's head, found by iterating the loop
 * to a fixed point); inside a try every call may land in the catches, so their live-in stays live
 */
function liveAfterCalls(body, nLocals) {
	const all = () => new Set(Array.from({ length: nLocals }, (_, i) => i));
	const out = new Map();
	const union = (...sets) => { const u = new Set(); for (const s of sets) for (const x of s) u.add(x); return u; };
	const rd = (e) => reads(e, new Set()) ?? all();
	const live = (e, after, env, exc) => {
		const id = E.getExpressionId(e);
		if (id === E.BlockId) {
			const b = new E.Block(e);
			const env2 = new Map(env);
			if (b.name) env2.set(b.name, after);
			let cur = after;
			for (let i = b.numChildren - 1; i >= 0; i--) cur = live(b.getChildAt(i), cur, env2, exc);
			return cur;
		}
		if (id === E.LoopId) {
			const l = new E.Loop(e);
			let head = new Set();
			for (;;) {
				const env2 = new Map(env);
				if (l.name) env2.set(l.name, head);
				const inn = live(l.body, after, env2, exc);
				if (inn.size === head.size && [...inn].every((x) => head.has(x))) return inn;
				head = union(head, inn);
			}
		}
		if (id === E.IfId) {
			const i = new E.If(e);
			return union(live(i.ifTrue, after, env, exc), i.ifFalse ? live(i.ifFalse, after, env, exc) : after, rd(i.condition));
		}
		if (id === E.TryId) {
			const t = new E.Try(e);
			const caught = [];
			for (let k = 0; k < t.numCatchBodies; k++) caught.push(live(t.getCatchBodyAt(k), after, env, exc));
			return live(t.body, after, env, union(exc, ...caught));
		}
		if (id === E.BreakId) {
			const b = E.getExpressionInfo(e);
			const target = env.get(b.name) ?? all();
			return b.condition ? union(after, target, rd(b.condition), b.value ? rd(b.value) : []) : union(target, b.value ? rd(b.value) : []);
		}
		if (id === E.SwitchId) {
			const sw = E.getExpressionInfo(e);
			return union(...[...sw.names, sw.defaultName].map((n) => env.get(n) ?? all()), rd(sw.condition));
		}
		if (id === E.ReturnId) return rd(e);
		if (id === E.UnreachableId) return new Set();
		if (id === E.ThrowId || id === E.RethrowId) return union(exc, rd(e));
		const call = callOf(e);
		// a resumed call may still throw into the catches, so their live-in is live after it too
		if (call) out.set(e, { after, exc });
		if (id === E.LocalSetId) {
			const ls = new E.LocalSet(e);
			const cur = new Set(after);
			cur.delete(ls.index);
			return union(cur, rd(ls.value), call ? exc : []);
		}
		return union(after, rd(e), call ? exc : []);
	};
	live(body, new Set(), new Map(), new Set());
	return out;
}
let sites = 0;
// per instrumented function: its locals, frame size and the ids of its sites
const frames = new Map();
if (handlers && side) {
	module.addTagImport('gmux.ckpt', 'gmux', 'ckpt', none, none);
	module.addGlobalImport('gmux.fp', 'gmux', 'fp', i32, true);
	module.addGlobalImport('gmux.unwinding', 'gmux', 'unwinding', i32, true);
} else if (handlers) {
	module.addTag('gmux.ckpt', none, none);
	module.addGlobal('gmux.fp', i32, true, module.i32.const(0));
	// set by the host while the kernel unwinds for a checkpoint: an import call returning into this
	// program then throws, so its frames evacuate where an asyncified program would unwind
	module.addGlobal('gmux.unwinding', i32, true, module.i32.const(0));
}
if (handlers) {
	for (let f = 0; f < module.getNumFunctions(); f++) {
		const fn = module.getFunctionByIndex(f);
		if (!binaryen.getFunctionInfo(fn).body) continue;
		// a body that is one call statement (musl's __restore_sigs) has no block for visit to wrap in
		binaryen._BinaryenFunctionSetBody(fn, blocked(binaryen.getFunctionInfo(fn).body));
		const info = binaryen.getFunctionInfo(fn);
		const types = [...binaryen.expandType(info.params), ...info.vars];
		const offsets = [];
		let at = 0;
		for (const type of types) {
			offsets.push(size[type] ? at : -1);
			at += size[type] ?? 0;
		}
		const frameSize = at + 4;
		// what a resume needs: the locals live once the call returns (the local the call sets comes from
		// its result), plus what the variant issues the call with: an import is called again with its
		// operands, a function resumes from its own frame (callee$resume takes none), and an indirect call
		// needs only its target
		const liveOut = liveAfterCalls(info.body, types.length);
		const needed = (stmt) => {
			const live = liveOut.get(stmt);
			if (!live) return null;
			const keep = new Set(live.after);
			// a throw skips the set, so a catch reading the local reads its value from before the call
			if (E.getExpressionId(stmt) === E.LocalSetId) keep.delete(new E.LocalSet(stmt).index);
			for (const x of live.exc) keep.add(x);
			const call = callOf(stmt);
			const cid = E.getExpressionId(call);
			const r =
				cid === E.CallIndirectId ? reads(E.getExpressionInfo(call).target, new Set())
				: cid === E.CallId && (!imports.has(new E.Call(call).target) || foreign.has(new E.Call(call).target)) ? new Set()
				: reads(call, new Set());
			if (!r) return null;
			for (const x of r) keep.add(x);
			return keep;
		};
		const spill = (site, stmt) => {
			const base = () => module.global.get('gmux.fp', i32);
			const stores = [];
			const keep = stmt && !allLocals ? needed(stmt) : null;
			types.forEach((type, index) => {
				if (offsets[index] < 0 || noSpill || (keep && !keep.has(index))) return;
				const get = module.local.get(index, type);
				const o = offsets[index];
				stores.push(
					type === i32 ? module.i32.store(o, 1, base(), get) :
					type === i64 ? module.i64.store(o, 1, base(), get) :
					type === f32 ? module.f32.store(o, 1, base(), get) :
					type === f64 ? module.f64.store(o, 1, base(), get) :
					module.v128.store(o, 1, base(), get)
				);
			});
			stores.push(module.i32.store(frameSize - 4, 1, base(), site === null ? module.local.get(siteLocal, i32) : module.i32.const(site)));
			stores.push(module.global.set('gmux.fp', module.i32.add(base(), module.i32.const(frameSize))));
			return stores;
		};
		const first = sites;
		let siteLocal = -1;
		// wrap each call statement of a block: in flat IR no value crosses a call except through locals
		const visit = (expr) => {
			const id = E.getExpressionId(expr);
			if (id === E.BlockId) {
				const block = new E.Block(expr);
				for (let i = 0; i < block.numChildren; i++) {
					const child = block.getChildAt(i);
					const inner = callOf(child);
					const iid = inner && E.getExpressionId(inner);
					const needed =
						(iid === E.CallIndirectId &&
							indirectReaches(signature(E.getExpressionInfo(inner).params, E.getExpressionInfo(inner).results))) ||
						(iid === E.CallId && reaches.has(new E.Call(inner).target));
					if (needed && E.getExpressionType(child) === none && oneTry) {
						if (siteLocal < 0) siteLocal = binaryen._BinaryenFunctionAddVar(fn, i32);
						block.setChildAt(i, module.block(null, [module.local.set(siteLocal, module.i32.const(sites)), child], none));
						sites++;
					} else if (needed && E.getExpressionType(child) === none) {
						const label = `gmux.try.${sites}`;
						const handler = module.block(null, [...spill(sites, child), module.rethrow(label)], unreachable);
						const body = iid === E.CallId && imports.has(new E.Call(inner).target) ? module.block(null, [child, unwindCheck()], none) : child;
						block.setChildAt(i, module.try(label, body, ['gmux.ckpt'], [handler]));
						sites++;
					} else visit(child);
				}
				return;
			}
			if (id === E.IfId) {
				const e = new E.If(expr);
				visit((e.ifTrue = blocked(e.ifTrue)));
				if (e.ifFalse) visit((e.ifFalse = blocked(e.ifFalse)));
			} else if (id === E.LoopId) {
				const e = new E.Loop(expr);
				visit((e.body = blocked(e.body)));
			} else if (id === E.TryId) {
				const e = new E.Try(expr);
				visit((e.body = blocked(e.body)));
				// a catch body starts with its pop, which may not move into a block
				for (let i = 0; i < e.numCatchBodies; i++) visit(e.getCatchBodyAt(i));
			}
		};
		visit(info.body);
		if (oneTry && sites > first) {
			const handler = module.block(null, [...spill(null), module.rethrow('gmux.fn')], unreachable);
			binaryen._BinaryenFunctionSetBody(fn, module.try('gmux.fn', info.body, ['gmux.ckpt'], [handler]));
		}
		if (sites > first) frames.set(info.name, { types, offsets, frameSize, first, last: sites - 1, results: info.results });
	}
}

function blocked(expr) {
	return E.getExpressionId(expr) === E.BlockId ? expr : module.block(null, [expr], E.getExpressionType(expr));
}

function unwindCheck() {
	return module.if(module.global.get('gmux.unwinding', binaryen.i32), module.throw('gmux.ckpt', []));
}

/** a site try's call statement, under the unwind check an import call carries */
function siteStmt(body) {
	return E.getExpressionId(body) === E.BlockId ? new E.Block(body).getChildAt(0) : body;
}

/** the call inside a call statement (bare, under a local.set, or under a drop), or null */
function callOf(stmt) {
	const id = E.getExpressionId(stmt);
	if (id === E.CallId || id === E.CallIndirectId) return stmt;
	if (id === E.LocalSetId) {
		const v = new E.LocalSet(stmt).value;
		const vid = v && E.getExpressionId(v);
		return vid === E.CallId || vid === E.CallIndirectId ? v : null;
	}
	if (id === E.DropId) {
		const v = new E.Drop(stmt).value;
		const vid = E.getExpressionId(v);
		return vid === E.CallId || vid === E.CallIndirectId ? v : null;
	}
	return null;
}

const variant = (name) => `${name}$resume`;
/** the expression a site path leads to */
function tryAt(expr, path) {
	for (const step of path) {
		const id = E.getExpressionId(expr);
		if (id === E.BlockId) expr = new E.Block(expr).getChildAt(step);
		else if (id === E.LoopId) expr = new E.Loop(expr).body;
		else if (id === E.IfId) expr = step === 'true' ? new E.If(expr).ifTrue : new E.If(expr).ifFalse;
		else expr = step === 'body' ? new E.Try(expr).body : new E.Try(expr).getCatchBodyAt(Number(String(step).slice(5)));
	}
	return expr;
}
const stats = { variants: 0, resumableSites: 0, unresumableSites: 0 };
if (resume && handlers) {
	const tables = [];
	for (let t = 0; t < module.getNumTables(); t++) tables.push(binaryen.getTableInfo(module.getTableByIndex(t)));
	for (const [name, base] of foreign)
		module.addFunctionImport(variant(name), 'env', variant(base), none, binaryen.getFunctionInfo(module.getFunction(name)).results);
	// every path from a function body to one of its site trys, as child steps
	const pathsOf = (body) => {
		const found = new Map();
		const walk = (expr, path) => {
			const id = E.getExpressionId(expr);
			if (id === E.BlockId) {
				const b = new E.Block(expr);
				for (let i = 0; i < b.numChildren; i++) walk(b.getChildAt(i), [...path, i]);
			} else if (id === E.LoopId) walk(new E.Loop(expr).body, [...path, 'body']);
			else if (id === E.IfId) {
				const e = new E.If(expr);
				walk(e.ifTrue, [...path, 'true']);
				if (e.ifFalse) walk(e.ifFalse, [...path, 'false']);
			} else if (id === E.TryId) {
				const e = new E.Try(expr);
				const m = /^gmux\.try\.(\d+)$/.exec(e.name ?? '');
				if (m) found.set(Number(m[1]), path);
				else {
					walk(e.body, [...path, 'body']);
					for (let i = 0; i < e.numCatchBodies; i++) walk(e.getCatchBodyAt(i), [...path, `catch${i}`]);
				}
			}
		};
		walk(body, []);
		return found;
	};

	let label = 0;
	const fresh = (kind) => `gmux.${kind}.${label++}`;
	const tryParts = (t) => {
		const catches = [], tags = [];
		for (let i = 0; i < t.numCatchBodies; i++) catches.push(module.copyExpression(t.getCatchBodyAt(i)));
		for (let i = 0; i < t.numCatchTags; i++) tags.push(t.getCatchTagAt(i));
		return { catches, tags };
	};
	/** the call statement of a site try, re-issued to the callee's variant (an import is called again) */
	const redo = (t) => {
		const stmt = siteStmt(t.body);
		const call = callOf(stmt);
		let again;
		if (E.getExpressionId(call) === E.CallId) {
			const c = new E.Call(call);
			again = imports.has(c.target) && !foreign.has(c.target) ? module.copyExpression(call) : module.call(variant(c.target), [], E.getExpressionType(call));
		} else {
			const c = new E.CallIndirect(call);
			again = module.call_indirect(`gmux.resume.${c.table}`, module.copyExpression(c.target), [], none, c.results);
		}
		const sid = E.getExpressionId(stmt);
		const call2 = sid === E.LocalSetId ? module.local.set(new E.LocalSet(stmt).index, again) : sid === E.DropId ? module.drop(again) : again;
		return stmt === t.body ? call2 : module.block(null, [call2, unwindCheck()], none);
	};

	/**
	 * one variant per function, shared by all its sites. res(expr, sites) runs with $resuming set,
	 * enters expr at the site $rid names and finishes expr as written; dual(expr, sites) is for a
	 * position normal execution can also reach: res when resuming, the original otherwise. A block
	 * dispatches once into the region holding the target child (the first region is reached only by
	 * the dispatch); a loop runs the rest of the current iteration, then an unmodified copy of itself
	 */
	const makeBuilder = (frame, rid, resuming) => {
		const n = frame.last - frame.first + 1;
		// br_table on $rid over the function's sites, each to the label of its group
		const dispatch = (groups) => {
			const targets = new Array(n).fill(groups[0].label);
			for (const g of groups) for (const s of g.sites) targets[s.id - frame.first] = g.label;
			return module.switch(targets, groups[0].label, module.local.get(rid, i32));
		};
		const group = (sites) => {
			const by = new Map();
			for (const s of sites) {
				const k = s.path[0];
				if (!by.has(k)) by.set(k, []);
				by.get(k).push({ id: s.id, path: s.path.slice(1) });
			}
			return by;
		};
		const res = (expr, sites) => {
			const id = E.getExpressionId(expr);
			if (sites.length === 1 && !sites[0].path.length) {
				const t = new E.Try(expr);
				const { catches, tags } = tryParts(t);
				return module.block(null, [module.local.set(resuming, module.i32.const(0)), module.try(t.name, redo(t), tags, catches)], none);
			}
			const by = group(sites);
			if (id === E.BlockId) {
				const b = new E.Block(expr);
				const idx = [...by.keys()].sort((x, y) => x - y);
				const groups = idx.map((i) => ({ i, label: fresh('j'), sites: by.get(i) }));
				let acc = [dispatch(groups)];
				groups.forEach((g, j) => {
					const end = j + 1 < groups.length ? groups[j + 1].i : b.numChildren;
					const region = [(j === 0 ? res : dual)(b.getChildAt(g.i), g.sites)];
					for (let c = g.i + 1; c < end; c++) region.push(module.copyExpression(b.getChildAt(c)));
					acc = [module.block(g.label, acc, none), ...region];
				});
				return module.block(b.name, acc, b.type);
			}
			if (id === E.LoopId) {
				const l = new E.Loop(expr);
				const inner = res(l.body, by.get('body'));
				if (!l.name) return inner;
				// a branch to the loop's label inside the peel leaves a block of that name and enters the
				// full loop; falling off the peel's end leaves the loop
				const after = fresh('after');
				return module.block(after, [module.block(l.name, [inner, module.br(after)], none), module.copyExpression(expr)], l.type);
			}
			if (id === E.IfId) {
				const e = new E.If(expr);
				const arms = [...by.keys()];
				if (arms.length === 1) return res(arms[0] === 'true' ? e.ifTrue : e.ifFalse, by.get(arms[0]));
				const out = fresh('if'), t = fresh('j'), f = fresh('j');
				const d = dispatch([{ label: t, sites: by.get('true') }, { label: f, sites: by.get('false') }]);
				return module.block(out, [
					module.block(f, [module.block(t, [d], none), res(e.ifTrue, by.get('true')), module.br(out)], none),
					res(e.ifFalse, by.get('false'))
				], E.getExpressionType(expr));
			}
			if (id === E.TryId) {
				const e = new E.Try(expr);
				const { catches, tags } = tryParts(e);
				return module.try(e.name, res(e.body, by.get('body')), tags, catches);
			}
			throw new Error(`unexpected expression ${id} on a resume path`);
		};
		const dual = (expr, sites) =>
			module.if(module.local.get(resuming, i32), res(expr, sites), module.copyExpression(expr));
		return res;
	};

	for (const [name, frame] of frames) {
		const info = binaryen.getFunctionInfo(module.getFunction(name));
		const paths = pathsOf(info.body);
		const base = frame.types.length, rid = base + 1, resuming = base + 2;
		const load = (type, o) => {
			const b = module.local.get(base, i32);
			return type === i32 ? module.i32.load(o, 1, b) : type === i64 ? module.i64.load(o, 1, b) : type === f32 ? module.f32.load(o, 1, b) : type === f64 ? module.f64.load(o, 1, b) : module.v128.load(o, 1, b);
		};
		const prologue = [
			module.local.set(base, module.i32.sub(module.global.get('gmux.fp', i32), module.i32.const(frame.frameSize))),
			module.global.set('gmux.fp', module.local.get(base, i32)),
			module.local.set(resuming, module.i32.const(1))
		];
		frame.types.forEach((type, index) => {
			if (frame.offsets[index] >= 0) prologue.push(module.local.set(index, load(type, frame.offsets[index])));
		});
		prologue.push(module.local.set(rid, module.i32.sub(module.i32.load(frame.frameSize - 4, 1, module.local.get(base, i32)), module.i32.const(frame.first))));
		// sites that cannot be resumed: inside a catch body, or calling a function that has no variant
		const sites = [];
		for (let k = frame.first; k <= frame.last; k++) {
			const path = paths.get(k);
			const t = new E.Try(tryAt(info.body, path));
			const call = callOf(siteStmt(t.body));
			const target = E.getExpressionId(call) === E.CallId ? new E.Call(call).target : null;
			if (path.some((step) => String(step).startsWith('catch')) || (target && !imports.has(target) && !frames.has(target))) {
				prologue.push(module.if(module.i32.eq(module.local.get(rid, i32), module.i32.const(k - frame.first)), module.unreachable()));
				stats.unresumableSites++;
				if (process.env.GMUX_EVAC_SITES) console.error(`unresumable ${name} site ${k - frame.first}: ${target ?? 'indirect'}${path.some((s) => String(s).startsWith('catch')) ? ' (in a catch)' : ''}`);
			} else {
				sites.push({ id: k, path });
				stats.resumableSites++;
			}
		}
		if (!sites.length) {
			module.addFunction(variant(name), none, info.results, [...frame.types, i32, i32, i32], module.unreachable());
			stats.variants++;
			continue;
		}
		const body = makeBuilder(frame, rid, resuming)(info.body, sites);
		const type = E.getExpressionType(body);
		const tail = type === none && info.results !== none ? [body, module.unreachable()] : type === none || type === unreachable ? [body] : [module.return(body)];
		module.addFunction(variant(name), none, info.results, [...frame.types, i32, i32, i32], module.block(null, [...prologue, ...tail], unreachable));
		stats.variants++;
	}
	// the resume table: slot i holds the variant of the function in slot i of the call table
	const stubs = new Map();
	const stubFor = (results) => {
		if (!stubs.has(results)) {
			const name = `gmux.resume.stub.${stubs.size}`;
			module.addFunction(name, none, results, [], module.unreachable());
			stubs.set(results, name);
		}
		return stubs.get(results);
	};
	for (const t of tables) {
		// the program's grows with its call table as side modules load; a side module's is the program's
		module.addTable(`gmux.resume.${t.name}`, t.initial, 0xffffffff, binaryen.funcref);
		if (side) module.addTableImport(`gmux.resume.${t.name}`, 'gmux', 'resume');
		else if (tables.length === 1) module.addTableExport(`gmux.resume.${t.name}`, 'gmux_resume');
		for (let s = 0; s < module.getNumElementSegments(); s++) {
			const seg = binaryen.getElementSegmentInfo(module.getElementSegmentByIndex(s));
			if (seg.table !== t.name) continue;
			const names = seg.data.map((fname) => {
				if (frames.has(fname)) return variant(fname);
				return stubFor(binaryen.getFunctionInfo(module.getFunction(fname)).results);
			});
			module.addActiveElementSegment(`gmux.resume.${t.name}`, `gmux.resume.seg.${s}`, names, module.copyExpression(seg.offset));
		}
	}

	for (let e = 0; e < module.getNumExports(); e++) {
		const x = binaryen.getExportInfo(module.getExportByIndex(e));
		if (x.kind === binaryen.ExternalFunction && frames.has(x.value)) module.addFunctionExport(variant(x.value), variant(x.name));
	}
	if (!side) {
		module.addTagExport('gmux.ckpt', 'gmux_ckpt');
		module.addGlobalExport('gmux.fp', 'gmux_fp');
		module.addGlobalExport('gmux.unwinding', 'gmux_unwinding');
	}
}
// the peeled copies repeat label names in sibling scopes, which wasm allows and binaryen's IR does
// not; the binary format resolves labels by depth and reading it back names them uniquely
const final = resume || process.env.GMUX_ROUNDTRIP ? binaryen.readBinary(module.emitBinary()) : module;
final.setFeatures(features);
binaryen.setOptimizeLevel(2);
// measurement knob: the size up to which a function with several callers is inlined
if (process.env.GMUX_FLEX_INLINE) binaryen.setFlexibleInlineMaxSize(Number(process.env.GMUX_FLEX_INLINE));
if (!process.env.GMUX_NO_OPT) final.optimize();
if (!final.validate()) throw new Error('invalid module');
writeFileSync(output, final.emitBinary());
console.log(JSON.stringify({ output, handlers, sites, functionsReachingASafepoint: reaches.size, functions: final.getNumFunctions(), ...(resume ? stats : {}) }));
