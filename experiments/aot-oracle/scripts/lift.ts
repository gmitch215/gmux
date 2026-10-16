import { readFileSync, writeFileSync } from 'node:fs';
import {
	KB_ZERO,
	MAX_SLOTS,
	SP,
	SPAN,
	deadFlags,
	edgesOf,
	findLoops,
	hex,
	imm64,
	isTemp,
	liveInTemps,
	opName,
	parseRanges,
	regionRegs,
	registerFields,
	rw,
	selectBlocks,
	touches,
	windowPlanner,
	constJump,
	type Acc,
	type Block,
	type Hit,
	type Ins,
	type Loop,
	type Touch,
	type Win
} from './region-ir.ts';
import { analyze, vecWrite, type Cls } from './slots.ts';

/**
 * The AOT oracle's lifter: turns the hottest blocks of each KATYBUG_HOT dump into C, one region per
 * dump (one process), which clang then compiles into katybug.wasm with -DKB_AOT. A region holds guest
 * registers and flags in locals and moves between its blocks with goto; everything else leaves to the
 * interpreter. A decoded block runs a region only if its IR matches the lifted one exactly
 * (kb_aot_attach), so the guard is the IR itself. A block may be a trace (KB_EXIT side exits).
 *
 * `lift.ts [--temps] [--nogroups] [--windows] [--bounds] [--regs] [--slots] [--calls] [--ranges=<lo>-<hi>,...] <out.c> <coverage 0..1> <dump.hot>[@<lo>-<hi>,...]...`
 *
 * `--ranges` replaces the coverage cut: the region is the dump's blocks that start in those code ranges (one hot
 * function and the callees worth keeping inside it, from functions.ts), and the lifter reports its direct edges
 * inside, leaving, and through a register. A block outside the ranges, or one that cannot be lifted, is an exit.
 * A dump with its own `@ranges` takes those instead, and the same dump may be listed again for another region.
 *
 * `--calls` makes an edge from a block of one region to a block of another a direct C call: the callee region's
 * `go` function inlined there, entered at that block and run to wherever it leaves (aot.h states the contract).
 * A call whose block fuses the callee's first block (the dump's blocks run on through direct jumps) is such an
 * edge too, into the callee's next block. Without it every region leaves at such an edge.
 * `LIFT_MUTATE=noreturn` makes it unsound on purpose: a callee's registers are not handed back to the caller.
 * `--noinline` calls the `go` function out of line instead, so the callee's registers cross through the io
 * struct in memory and each form holds one copy of the callee.
 *
 * The flags are the representation ladder's rungs (ladder.sh): `--temps` keeps only architectural
 * registers across blocks and helper calls, `--nogroups` ignores the memory plan's KB_RESOLVE groups,
 * `--windows` runs each block's provable accesses (entry base or constant address plus offset) as
 * plain host accesses inside windows resolved once at the block's entry, with a checked copy of the
 * block for a window that does not resolve. `--bounds` adds the accesses whose address is such a base plus an
 * index with a bound (bounds.ts: a mask, an extension, a byte load, a compare the trace's exits proved), as a
 * window from the index's low end to its high end, at most one piece (64 KiB) wide; the access is at the window
 * plus its own distance from the window's start. `LIFT_MUTATE=shortwindow` ends such a window one element early
 * (unsound), `longwindow` one element late (a window that no longer resolves leaves to the checked copy).
 *
 * `--regs` emits each region twice: the form above, and a precise form (`r<n>p_run`) that spills
 * and reloads around an SSE, x87 or string helper only the registers and flags that helper can
 * read or write, and keeps the fs base in a local; `KATYBUG_REGS=1` picks it at run time. A
 * syscall still spills and reloads everything (it can fork, switch threads or deliver a signal).
 *
 * `--slots` adds a third form (`r<n>s_run`, `KATYBUG_REGS=2`) of the precise form that keeps rsp-relative
 * stack slots in locals across blocks (slots.ts); every store still writes memory. Needs `--temps
 * --windows`. `LIFT_MUTATE=noguard|nowrite` makes it unsound on purpose (an unknown store no longer
 * refreshes the slots; a slot store no longer reaches memory), so a check can show it fails.
 *
 * `--only=<0|1|2>` emits one body per region, the one form a product build holds, and points `aot_run` at it
 * (`aot_regs()` is not read, so `KATYBUG_REGS` does nothing): 0 is the plain form, 1 the precise one (needs `--regs`),
 * 2 the slots one (needs `--slots`; a region with no slot plan gets the precise body). No `aot_runp` or `aot_runs`.
 *
 * `--epochs` (build with -DKB_EPOCH=1) lifts to the interpreter's epoch guard: a region reads kb_epoch once when
 * it is entered and checks its caches against the mapping generation once then (a cache is cold or current, so
 * no window, group or access compares a generation), and a back edge leaves when kb_epoch is no longer the
 * entry's, which every signal and mapping change moves. Without it the generated C is what it was.
 *
 * `--identity` runs every guest load and store as a plain access through `AOT_HOST(va)` (aot.h): no windows, groups or
 * caches, no fault check. Only a runtime that maps the guest at its own addresses can run it, and a bad guest access
 * kills the host; measurement only.
 *
 * `--classes` (build with -DAOT_CLASS) makes each access report its kind (window, group, checked, slot in a local,
 * frame window), load or store and the mapping it lands in, per access and per generated source line (aot.h), to
 * `$KATYBUG_COUNT` at exit; the generated code is otherwise the same. `--plainchk` runs the accesses that would be
 * checked one by one as plain accesses through `AOT_HOST(va)` while windows stay as they are: a ceiling for any form that
 * proves those accesses, unsafe like `--identity` (a runtime that maps guests at their own addresses, or -DKB_WINDOW).
 *
 * `--bind=<count file>` is for a measurement of what a flat mapping table could give the checked accesses: the count
 * file is the `$KATYBUG_COUNT` of a `--classes` run of the same lift (same flags and dumps, so the site ids agree, run
 * on the window runtime so the mappings sit where the arm will see them). A checked load or store whose site saw one
 * mapping first tests its address against that mapping's bounds (`va - lo <= span - width`) and reads or writes
 * `AOT_HOST(lo) + (va - lo)`; a miss takes the site's cache as before. The bounds are locals a region loads when it
 * is entered from `aot_flat` (filled at start up, so the compiler cannot fold them); `--bindconst` writes them as
 * constants instead (a floor for any site-bound form: no loads at all). `--bindexit` makes a miss leave the region through
 * the fault exit (pc and ipc of the access, no fault set) and drops the cache fallback: what a form that leaves to the
 * interpreter on a miss would cost. Unsound outside the layout of the counted run.
 *
 * `--flat=<count file>` (with `--epochs`, built with -DKB_EPOCH=1 and -DKB_FLAT=<bytes>) is the same site-bound check in a
 * form that is sound anywhere: the census only says which mapping to look for. A region's epoch slow path finds each one
 * again by its first address (`kb_flat_open`: one block, the right the site needs) and a region reads its bounds from that
 * table as it is entered; a mapping that is gone, in pieces, or without the right has no bound, and every access of its sites
 * takes its cache. A site's fast path is `va - lo < lim`, where lim is 16 less than the mapping's size.
 *
 * `--flags=live` (the default; `--flags=all` keeps every flag write) drops a flag write that a backward liveness over the region's blocks proves unread. Every exit, helper
 * call, syscall and fault point (a load or store, unless `--identity`) reads all five flags, except an exit whose target
 * block is in the dump and writes all five before it reads any. `--flags=none` is the same pass with the exits, helpers,
 * syscalls and fault points reading nothing, so only flags a later op of the region reads survive: unsound where the
 * interpreter reads one, measurement only. `LIFT_MUTATE=exitdead` makes `live` unsound the same way for exits alone,
 * `faultdead` for the loads and stores alone (what `--identity` does soundly, with the accesses left as they are).
 */
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const [out = '', coverageArg = '0.99', ...dumps] = args.filter((a) => !a.startsWith('--'));
const opt = {
	temps: flags.has('--temps'),
	nogroups: flags.has('--nogroups'),
	windows: flags.has('--windows'),
	regs: flags.has('--regs') || flags.has('--slots'),
	slots: flags.has('--slots'),
	calls: flags.has('--calls'),
	noinline: flags.has('--noinline'),
	epochs: flags.has('--epochs'),
	identity: flags.has('--identity'),
	classes: flags.has('--classes'),
	plainchk: flags.has('--plainchk'),
	bindconst: flags.has('--bindconst'),
	bindexit: flags.has('--bindexit'),
	bounds: [...flags].some((f) => f === '--bounds' || f.startsWith('--bounds=')),
	two: flags.has('--bounds=two'),
	loops: flags.has('--loop-guards')
};
const flagsFlag = [...flags].find((f) => f.startsWith('--flags'));
const flagsMode = flagsFlag === undefined ? 'live' : (/^--flags=(all|live|none)$/.exec(flagsFlag)?.[1] ?? '');
if (!flagsMode) throw new Error('--flags takes all, live or none (--flags=live)');
// a cache that is not cold is current under epochs, so the generation compare is left out
const G = opt.epochs ? '' : 'q->gen == gen && ';
const mutate = process.env.LIFT_MUTATE ?? '';
if (opt.slots && !(opt.temps && opt.windows)) throw new Error('--slots needs --temps and --windows');
if (opt.loops && !(opt.temps && opt.windows)) throw new Error('--loop-guards needs --temps and --windows');
if (opt.two && opt.identity) throw new Error('--bounds=two has no windows under --identity');
const bindFile = [...flags].find((f) => f.startsWith('--bind='))?.slice(7);
if ((opt.bindconst || opt.bindexit) && !bindFile) throw new Error('--bindconst and --bindexit need --bind=<count file>');
if (bindFile && (opt.identity || opt.plainchk)) throw new Error('--bind has no checked accesses under --identity or --plainchk');
const flatFile = [...flags].find((f) => f.startsWith('--flat='))?.slice(7);
if (flatFile && (bindFile || opt.identity || opt.plainchk)) throw new Error('--flat has no checked accesses under --identity or --plainchk, and replaces --bind');
if (flatFile && !opt.epochs) throw new Error('--flat needs --epochs (the mapping table is made again when kb_epoch has moved)');
// the mapping each checked site saw in a --classes run of the same lift (same flags, so the site ids agree); a site that saw
// two mappings, or a store site whose mapping is not writable, is left to its cache. Under --flat a table entry is a mapping
// and what its sites do (load or store): a region finds the mapping again at run time from its first address
const flat: { lo: bigint; span: bigint; st: number }[] = [];
const bound = new Map<number, number>();
const censusFile = bindFile ?? flatFile;
if (censusFile) {
	const text = readFileSync(censusFile, 'utf8');
	const ends = new Map<string, { end: bigint; prot: number; bits: number }>();
	for (const m of text.matchAll(/^katybug cls: kind 2 st \d start ([0-9a-f]+) end ([0-9a-f]+) prot (-?\d+) bits (\d+)/gm)) {
		const end = BigInt(`0x${m[2]}`);
		const had = ends.get(m[1]!);
		if (!had || end > had.end) ends.set(m[1]!, { end, prot: Number(m[3]), bits: Number(m[4]) });
	}
	for (const m of text.matchAll(/^katybug site: id (\d+) kind 2 st (\d) w \d+ n \d+ page \d+ same \d+ multi 0 map ([0-9a-f]+)/gm)) {
		const row = ends.get(m[3]!);
		const st = Number(m[2]);
		if (!row || (st && !(row.prot & 2))) continue;
		// a site on a mapping that was in pieces, or a store to one that is executable too, never takes the table's fast path
		if (flatFile && (row.bits !== 63 || (!st && !(row.prot & 3)) || (st && row.prot & 4))) continue;
		const lo = BigInt(`0x${m[3]}`);
		let k = flat.findIndex((f) => f.lo === lo && f.lo + f.span === row.end && (!flatFile || f.st === st));
		if (k < 0) k = flat.push({ lo, span: row.end - lo, st }) - 1;
		bound.set(Number(m[1]), k);
	}
	console.error(`--${flatFile ? 'flat' : 'bind'}: ${bound.size} checked sites in ${flat.length} mappings`);
}
// one number per load or store emitted, in emission order, with or without --classes or --bind
let siteSeq = 0;
const onlyFlag = [...flags].find((f) => f.startsWith('--only'));
const globalOnly = onlyFlag === undefined ? undefined : Number(/^--only=([012])$/.exec(onlyFlag)?.[1] ?? NaN);
// the form of the region being lifted: --only, or the dump's own `#<form>`
let only = globalOnly;
const checkForm = (f: number | undefined) => {
	if (f !== undefined && Number.isNaN(f)) throw new Error('--only takes 0, 1 or 2 (--only=1)');
	if (f === 1 && !opt.regs) throw new Error('--only=1 needs --regs');
	if (f === 2 && !opt.slots) throw new Error('--only=2 needs --slots');
};
checkForm(globalOnly);
const coverage = Number(coverageArg);
// `--ranges=<lo>-<hi>,...` lifts the blocks that start in those code ranges (a function and its callees), however hot
const globalRanges = [...flags].find((f) => f.startsWith('--ranges='))?.slice(9);
// a dump of its own form reads <dump>#<0|1|2>[@<lo>-<hi>,...]: ELFs lifted into one table need not share one form
const specs = dumps.map((d) => {
	const [head = '', own] = d.split('@');
	const [path = '', formText] = head.split('#');
	const form = formText === undefined ? undefined : Number(/^[012]$/.test(formText) ? formText : NaN);
	checkForm(form);
	const text = own ?? globalRanges;
	return { path, form, ranges: text === undefined ? undefined : parseRanges(text) };
});
// one piece of a mapping (kb.h KB_PIECE_BITS) is the widest window a resolve can cover; --bounds=<bytes> takes less
const BIG = BigInt(opt.two ? 1 << 16 : ([...flags].find((f) => f.startsWith('--bounds='))?.slice(9) ?? 1 << 16));
const { windowsOf, accessesOf, group } = windowPlanner({ identity: opt.identity, bounds: opt.bounds, two: opt.two, big: BIG, mutate });

// a region's direct edges: inside it (a goto), leaving it (an exit to the interpreter), and the jumps through a register
function edgeReport(dump: string, chosen: Block[], direct = 0) {
	const starts = new Set(chosen.map((b) => b.pc));
	let inside = 0;
	let outside = 0;
	let indirect = 0;
	let syscalls = 0;
	for (const b of chosen) {
		const last = b.ins.at(-1)!;
		if (opName(last.op) === 'JMP' && constJump(b) === undefined) indirect++;
		else if (opName(last.op) === 'SYSCALL') syscalls++;
		for (const t of edgesOf(b)) if (starts.has(t)) inside++;
		else outside++;
	}
	console.error(`${dump}: region ${chosen.length} blocks, ${inside} direct edges inside, ${outside} leaving, ${indirect} jumps through a register, ${syscalls} syscalls${direct ? `, ${direct} of the leaving go straight into another region` : ''}`);
}

// --bind: the mappings' bounds sit in a table filled at start up, so a region loads them as it is entered and the compiler
// cannot fold them into the code
const flatTable = bindFile && !opt.bindconst && flat.length
	? [`static uint64_t aot_flat[${flat.length}][2];`, '__attribute__((constructor)) static void aot_flat_init(void) {', ...flat.map((f, k) => `\taot_flat[${k}][0] = ${hex(f.lo)}; aot_flat[${k}][1] = ${hex(f.span)};`), '}', '']
	: [];
// --flat: the mappings are found again from their first address when the mapping generation has moved since the table was
// made (a region's epoch slow path calls this, so a region that is entered finds the table current); lim 0 gives no fast path
// LIFT_MUTATE=flatrights asks for read rights for a store's mapping, noflatsync makes the table again only while an entry is empty
const flatSync = flatFile && flat.length
	? [
			`static const uint64_t aot_fhint[${flat.length}][2] = {${flat.map((f) => `{${hex(f.lo)}, ${f.st && mutate !== 'flatrights' ? 'KB_W' : 'KB_R'}}`).join(', ')}};`,
			`static struct { uint64_t lo, lim; uint8_t* host; } aot_flat[${flat.length}];`,
			'static uint32_t aot_flat_mg;',
			'static int aot_flat_ok;',
			'static void aot_flat_sync(struct kb_cpu* cpu) {',
			`\tif (__builtin_expect(${mutate === 'noflatsync' ? `${flat.map((_, k) => `aot_flat[${k}].lim == 0`).join(' || ')} || ` : 'aot_flat_mg != cpu->mapgen || '}!aot_flat_ok, 0)) {`,
			'\t\tAOT_STAT(flat_sync, 1);',
			`\t\tfor (int k = 0; k < ${flat.length}; k++) kb_flat_open(cpu, aot_fhint[k][0], (int) aot_fhint[k][1], &aot_flat[k].lo, &aot_flat[k].lim, &aot_flat[k].host);`,
			'\t\taot_flat_ok = 1;',
			'\t\taot_flat_mg = cpu->mapgen;',
			'\t}',
			'}',
			''
		]
	: [];
const lines: string[] = [...(opt.epochs ? ['#define AOT_EPOCHS 1'] : []), '#include <string.h>', '#include "aot.h"', '', ...flatTable, ...flatSync];
const table: { pc: bigint; next: bigint; target: bigint; n: number; region: number; idx: number; name: string; pcs: string }[] = [];
const regionNames: string[] = [];
const regionSizes: number[] = [];
const regionSlotted: boolean[] = [];
let irIns = 0;
let windowCount = 0;

// each region's blocks, chosen before any is lifted so a call can name the region it enters
const selected = specs.map(({ path, ranges }) => selectBlocks(path, ranges, coverage));

// a region of no blocks (a function the run never reached) is dropped unless it is the only one
const keep = (_: unknown, r: number) => selected[r]!.chosen.length > 0 || specs.length === 1;
const live = specs.filter(keep);
const picked = selected.filter(keep);
// a build holds one form of every region or every form of every region: aot_run points at a region's only body
const formOf = (r: number) => live[r]!.form ?? globalOnly;
const oneForm = live.every((_, r) => formOf(r) !== undefined);
if (!oneForm && live.some((_, r) => formOf(r) !== undefined)) throw new Error('a dump with its own form needs every dump to have one (or --only)');

// direct calls: an edge from a block to a block of another region that has no syscall (a syscall can fork or switch
// threads, and needs every register in the cpu) runs that region inline, from that block to wherever it leaves. An
// edge that would close a cycle between regions leaves instead, so each callee is emitted before its callers
// a pc names a block of its own dump's program only: dumps of other programs in the same table reuse the addresses
const owner = new Map<string, number>();
const ownerKey = (r: number, pc: bigint) => `${live[r]!.path} ${pc}`;
picked.forEach((p, r) => p.chosen.forEach((b) => owner.has(ownerKey(r, b.pc)) || owner.set(ownerKey(r, b.pc), r)));
const noSyscall = picked.map((p) => p.chosen.every((b) => b.ins.every((x) => opName(x.op) !== 'SYSCALL')));
const calleesOf = picked.map((p, r) => {
	const out = new Map<bigint, number>();
	if (opt.calls)
		for (const b of p.chosen)
			for (const t of edgesOf(b)) {
				const to = owner.get(ownerKey(r, t));
				if (to !== undefined && to !== r && noSyscall[to]) out.set(t, to);
			}
	return out;
});
const order: number[] = [];
const visiting: number[] = picked.map(() => 0);
const visit = (r: number) => {
	visiting[r] = 1;
	for (const [to, c] of [...calleesOf[r]!]) {
		if (visiting[c] === 1) calleesOf[r]!.delete(to);
		else if (visiting[c] === 0) visit(c);
	}
	visiting[r] = 2;
	order.push(r);
};
picked.forEach((_, r) => visiting[r] || visit(r));
const called = new Set([...calleesOf].flatMap((m) => [...m.values()]));
// what a caller needs of a region it calls, once that region is emitted
const info: { name: string; regList: number[]; index: Map<bigint, number>; slotted: boolean }[] = [];

order.forEach((region) => {
	only = formOf(region);
	const dump = live[region]!.path;
	const { all, chosen, share } = picked[region]!;
	const ranges = live[region]!.ranges;
	const calls = calleesOf[region]!;
	if (ranges) edgeReport(dump, chosen, chosen.flatMap(edgesOf).filter((t) => calls.has(t)).length);
	console.error(`${dump}: ${all.length} blocks, ${chosen.length} lifted, ${(100 * share).toFixed(2)}% of executed ops`);

	const R = `r${region}`;
	regionNames[region] = `${R}_run`;
	regionSizes[region] = chosen.length;
	const index = new Map(chosen.map((b, j) => [b.pc, j]));
	const dead = flagsMode === 'all' ? new Set<string>() : deadFlags(chosen, index, calls, new Map(all.map((b) => [b.pc, b])), { mode: flagsMode, mutate, identity: opt.identity });
	if (flagsMode !== 'all') console.error(`${dump}: --flags=${flagsMode} drops ${dead.size} of ${chosen.reduce((n, b) => n + b.ins.filter((x) => opName(x.op) === 'FLAGS').length, 0)} flag writes`);
	const arch =/^arch (\d+)$/m.exec(readFileSync(dump, 'utf8'));
	const found = opt.slots && (only === undefined || only === 2) && (!arch || arch[1] === '0') ? analyze(chosen, index, { name: opName, rw, sp: SP, zero: KB_ZERO, span: SPAN, maxSlots: MAX_SLOTS }) : undefined;
	const plan = found?.promoted.some(Boolean) ? found : undefined;
	if (plan) {
		const loads = plan.slots.length;
		console.error(`${dump}: ${plan.promoted.filter(Boolean).length} blocks in ${plan.wins.length} frames, ${loads} slots, windows ${plan.wins.map((w) => w.hi - w.lo).join(' ')} bytes`);
	}
	// a region that can be called or that calls holds every register a helper reads or writes and every register of
	// its callees, so a register is never in the cpu on one side of a call and in a local on the other
	const regs = regionRegs(chosen, opt.calls);
	const callee = new Set(calls.values());
	const extraCross = new Set<number>();
	for (const c of callee)
		for (const r of info[c]!.regList) {
			regs.add(r);
			extraCross.add(r);
		}
	const liveIn = liveInTemps(chosen);
	if (liveIn.size) console.error(`${dump}: temporaries live across blocks: ${[...liveIn].join(' ')}`);
	const cross = (r: number) => !opt.temps || !isTemp(r) || liveIn.has(r) || extraCross.has(r);
	const reg = (r: number) => (r === KB_ZERO ? '(uint64_t) 0' : `g${r}`);
	const dst = (r: number) => (r === KB_ZERO ? 'sink' : `g${r}`);
	const regList = [...regs].filter(cross).sort((a, b) => a - b);

	// the window array's index of each window of a block's fast body
	const winBase = new Map<number, number[]>();
	// the statements that resolve a window into its variables (a two-piece one through aot_open2)
	// a window that serves a store resolves for writing, one that only loads for reading (the mutant `storeread` resolves
	// a store window for reading)
	const rights = (store: boolean) => (store && mutate !== 'storeread' ? 'KB_W' : 'KB_R');
	const open = (w: Win, v: { w: string; va: string; x: string; bd: string }, ic: number, setVa: boolean) => {
		const len = Number(w.hi - w.lo);
		const at = w.root < 0 ? hex(w.lo) : `${reg(w.root)} + ${imm64(w.lo)}`;
		const acc = rights(!!w.store);
		if (w.two)
			return [`\t{ uint64_t va = ${at}; ${v.va} = va; ${v.w} = aot_open2(cpu, &${R}_win[${ic}], &${R}_win[${ic + 1}], ${opt.epochs ? '0' : 'gen'}, va, ${len}u, ${acc}, &${v.x}, &${v.bd}); }`];
		return [
			`\t{ uint64_t va = ${at}; struct kb_ic* q = &${R}_win[${ic}];${setVa ? ` ${v.va} = va;` : ''}`,
			`\t  ${v.w} = ${G}${len}u <= q->span && va - q->lo <= q->span - ${len}u ? q->host + (va - q->lo) : kb_host_ic_at(cpu, q, va, ${len}u, ${acc}); }`
		];
	};
	// #region loops (--loop-guards)
	// a loop's windows resolve when it is entered and after a syscall or call inside it; one that fails leaves its accesses
	// checked one by one, so the fault is where the guest instruction is
	const nest = opt.loops
		? findLoops(
				chosen.map((b) => edgesOf(b).map((t) => index.get(t)).filter((k): k is number => k !== undefined)),
				chosen.map((b) => b.runs)
			)
		: { loops: [] as Loop[], of: chosen.map(() => -1) };
	const loopWrites = nest.loops.map((l) => {
		const w = new Set<number>();
		let all = false;
		for (const j of l.blocks) {
			const b = chosen[j]!;
			// a direct call runs another region's blocks on these registers
			if (edgesOf(b).some((t) => calls.has(t))) all = true;
			for (const x of b.ins) {
				const name = opName(x.op);
				for (const r of rw(x).w) w.add(r);
				if (name === 'X86STR' || name === 'SSE' || name === 'X87') for (const r of touches(x).w) w.add(r);
				if (name === 'X86MD') [0, 2].forEach((r) => w.add(r));
				if (name === 'SYSCALL') {
					if (!arch || arch[1] === '0') [0, 1, 11].forEach((r) => w.add(r));
					else all = true;
				}
			}
		}
		return { w, all };
	});
	interface LoopData {
		wins: Win[];
		// the hits of each block, by instruction
		hits: Map<number, Map<number, Hit>>;
		// the loops with windows around each block, outer first
		chain: number[][];
		byLoop: Map<number, number[]>;
	}
	const loopCache = new Map<boolean, LoopData>();
	const loopData = (slotted: boolean): LoopData => {
		const cached = loopCache.get(slotted);
		if (cached) return cached;
		const KEY = 1 << 16;
		const per = new Map<number, Acc[]>();
		chosen.forEach((b, j) => {
			if (nest.of[j]! < 0) return;
			const up: number[] = [];
			for (let l = nest.of[j]!; l >= 0; l = nest.loops[l]!.parent) up.unshift(l);
			for (const a of accessesOf(b, slotted && !!plan?.promoted[j])) {
				// the outermost loop the access's base register is not written in
				const owner = up.find((o) => a.root < 0 || (!loopWrites[o]!.all && !loopWrites[o]!.w.has(a.root)));
				if (owner !== undefined) (per.get(owner) ?? per.set(owner, []).get(owner)!).push({ ...a, i: j * KEY + a.i });
			}
		});
		const wins: Win[] = [];
		const hits = new Map<number, Map<number, Hit>>();
		const byLoop = new Map<number, number[]>();
		for (const [o, list] of [...per].sort((p, q) => p[0] - q[0])) {
			const g = group(list);
			const first = wins.length;
			byLoop.set(o, g.wins.map((_, k) => first + k));
			for (const w of g.wins) {
				w.ic = windowCount;
				windowCount += w.two ? 2 : 1;
				wins.push(w);
			}
			for (const [key, h] of g.hits) {
				const j = Math.floor(key / KEY);
				(hits.get(j) ?? hits.set(j, new Map()).get(j)!).set(key % KEY, { ...h, win: first + h.win, loop: true });
			}
		}
		const chain = chosen.map((_, j) => {
			const c: number[] = [];
			for (let l = nest.of[j]!; l >= 0; l = nest.loops[l]!.parent) if (byLoop.has(l)) c.unshift(l);
			return c;
		});
		const made = { wins, hits, chain, byLoop };
		loopCache.set(slotted, made);
		return made;
	};
	const lvars = (g: number) => ({ w: `lw${g}`, va: `lva${g}`, x: `lx${g}`, bd: `lbd${g}` });
	// resolves every window of the loops around block j (all of them when `all`, else the loops j's source is not in)
	// LIFT_MUTATE=noreval keeps the windows in statics across region exits and resolves one only when it is empty, so
	// nothing revalidates it after a syscall, a call or a handler
	const openLoops = (ld: LoopData, ids: number[]) =>
		ids.flatMap((g) => {
			const lines = open(ld.wins[g]!, lvars(g), ld.wins[g]!.ic!, true);
			return mutate === 'noreval' ? [`\tif (!lw${g}) {`, ...lines, '\t}'] : lines;
		});
	const loopIds = (ld: LoopData, j: number) => ld.chain[j]!.flatMap((l) => ld.byLoop.get(l)!);
	// whether an edge from block j into block k enters a loop j is not in, which resolves its windows first
	const entersLoop = (slotted: boolean, j: number, k: number) => {
		if (!opt.loops) return false;
		const ld = loopData(slotted);
		return ld.chain[k]!.some((l) => !ld.chain[j]!.includes(l));
	};
	// #endregion
	// the slots form: sm is a block that keeps its frame's slots in locals (the fast body of a promoted
	// block); every other body of that form only has to enter promoted blocks through their stubs
	// the other regions' blocks a block's emitted bodies go straight into, for bodyOf to emit the calls
	const edges = new Set<bigint>();
	const emit = (b: Block, j: number, mode: 'plain' | 'fast' | 'slow', precise = false, slotted = false) => {
		const fast = mode === 'fast';
		const sm = slotted && fast && !!plan?.promoted[j];
		const loops = opt.loops ? loopData(slotted) : undefined;
		const ld = fast ? loops : undefined;
		const lhits = ld?.hits.get(j);
		const pin = fast ? windowsOf(b, sm, lhits && new Set(lhits.keys())) : { wins: [] as Win[], hits: new Map<number, Hit>(), hard: [] as boolean[] };
		const hitOf = (i: number) => lhits?.get(i) ?? pin.hits.get(i);
		const label = mode === 'slow' ? `S${j}` : `B${j}`;
		const body: string[] = [];
		let ipcNow = 0n;
		let ipc = b.pc;
		let m = 0;
		const grouped = (x: Ins) => !opt.nogroups && !opt.identity && x.c !== 0 && !sm;
		const frame = sm ? plan!.wins[plan!.comp[j]!]! : { lo: 0, hi: 0 };
		const V = new Set<number>(sm ? plan!.need[j] : []);
		const slotLoad = (id: number) => {
			const s = plan!.slots[id]!;
			return `s${id} = 0; memcpy(&s${id}, wf + ${s.off - frame.lo}, ${s.w});`;
		};
		const cnt = (cat: string, k: number, n = 1) => (slotted ? [`\tAOT_COUNT_CAT(${cat}, ${k}, ${n});`] : []);
		// an unknown store may have hit the frame: read again the valid slots it overlaps
		const refresh = (va: string, w: number) => {
			if (!V.size || mutate === 'noguard') return [];
			const hit = `${va} - fl + ${w - 1} < ${frame.hi - frame.lo + w - 1}ull`;
			const each = [...V].map((id) => {
				const s = plan!.slots[id]!;
				const at = s.off - frame.lo;
				return `if (d + ${w} > ${at} && d < ${at + s.w}) { ${slotLoad(id)} AOT_COUNT_CAT(AOT_C_FIX, 1, 1); }`;
			});
			return [`\tif (__builtin_expect(${hit}, 0)) { int64_t d = (int64_t) (${va} - fl); ${each.join(' ')} }`];
		};
		const kill = (ids: number[]) => ids.forEach((id) => V.delete(id));
		const exitD = (i: number) => plan?.sym[j]?.exits.find((e) => e.i === i)?.d ?? null;
		const temps = opt.temps ? [...new Set(b.ins.flatMap((x) => [...registerFields(x), ...rw(x).w]))].filter((r) => isTemp(r) && !cross(r)) : [];
		// the cpu words each moves: ipc, the registers, five flags and df; a reload also reads mapgen
		const state = regList.length + 7;
		const spill = (extra: number[], cat: string) => {
			body.push(`\tcpu->ipc = ${hex(ipcNow)};`);
			body.push(...[...regList, ...extra].map((r) => `\tcpu->r[${r}] = g${r};`));
			body.push('\tcpu->n = f.n; cpu->z = f.z; cpu->c = f.c; cpu->v = f.v; cpu->p = f.p; cpu->df = df;');
			body.push(`\tAOT_COUNT_WRC(${cat}, ${state + extra.length});`);
		};
		const reload = (cat: string) => {
			body.push(...regList.map((r) => `\tg${r} = cpu->r[${r}];`));
			body.push(`\tf.n = cpu->n; f.z = cpu->z; f.c = cpu->c; f.v = cpu->v; f.p = cpu->p; df = cpu->df;${opt.epochs ? '' : ' gen = cpu->mapgen;'}`);
			if (precise) body.push('\tgfs = cpu->fs;');
			body.push(`\tAOT_COUNT_RDC(${cat}, ${state + (precise ? 1 : 0) - (opt.epochs ? 1 : 0)});`);
		};
		// the precise form: a helper's registers and flags only; a register it may write is spilled too, so
		// the reload never reads a stale word, and a fault leaves through out with every local current
		const held = (r: number) => r !== KB_ZERO && (regList.includes(r) || (isTemp(r) && !cross(r)));
		const spillTouch = (t: Touch, cat: string) => {
			const rs = [...new Set([...t.r, ...t.w])].filter(held);
			body.push(`\tcpu->ipc = ${hex(ipcNow)};`);
			body.push(...rs.map((r) => `\tcpu->r[${r}] = g${r};`));
			if (t.flags) body.push('\tcpu->n = f.n; cpu->z = f.z; cpu->c = f.c; cpu->v = f.v; cpu->p = f.p;');
			if (t.df) body.push('\tcpu->df = df;');
			body.push(`\tAOT_COUNT_WRC(${cat}, ${1 + rs.length + (t.flags ? 5 : 0) + (t.df ? 1 : 0)});`);
		};
		const reloadTouch = (t: Touch, cat: string) => {
			const ws = [...new Set(t.w)].filter((r) => regList.includes(r));
			body.push(...ws.map((r) => `\tg${r} = cpu->r[${r}];`));
			if (t.flags) body.push('\tf.n = cpu->n; f.z = cpu->z; f.c = cpu->c; f.v = cpu->v; f.p = cpu->p;');
			if (!opt.epochs) body.push('\tgen = cpu->mapgen;');
			body.push(`\tAOT_COUNT_RDC(${cat}, ${ws.length + (t.flags ? 5 : 0) + (opt.epochs ? 0 : 1)});`);
		};
		// a block's exit: straight into the next lifted block when there is one and no signal waits
		const leave = (from: bigint, to: bigint, i: number) => {
			const k = index.get(to);
			if (k === undefined && calls.has(to)) {
				const c = info[calls.get(to)!]!;
				edges.add(to);
				return `{ if (AOT_CONTINUE(${c.name}_ok[${c.index.get(to)}], ${to <= from ? 1 : 0})) goto K${j}_${to.toString(16)}; pc = ${hex(to)}; goto out; }`;
			}
			if (k === undefined) return `{ pc = ${hex(to)}; goto out; }`;
			const kind = !slotted || !plan ? 'plain' : sm ? plan.edge(j, k, exitD(i)) : plan.promoted[k] ? 'stub' : 'plain';
			const fix = kind === 'carry' ? plan!.need[k]!.filter((s) => !V.has(s)) : [];
			// an edge into a loop from outside it goes through that loop's stub, which resolves its windows
			const L = entersLoop(slotted, j, k) ? 'L' : '';
			const take = fix.length ? `{ ${fix.map(slotLoad).join(' ')} AOT_COUNT_CAT(AOT_C_FIX, 0, ${fix.length}); goto ${L}B${k}; }` : `goto ${L}${kind === 'stub' ? 'E' : 'B'}${k};`;
			return `{ if (AOT_CONTINUE(${R}_ok[${k}], ${to <= from ? 1 : 0})) ${take} pc = ${hex(to)}; goto out; }`;
		};
		const fault = (why?: string, sig?: number) =>
			`{ ${why ? `cpu->fault = "${why}"; cpu->fault_sig = ${sig}; ` : ''}cpu->ipc = ${hex(ipc)}; pc = ${hex(b.pc)}; goto out; }`;

		// an access with an index bound is at its own distance from where its window starts
		const winOf = (h: Hit) => (h.loop ? ld!.wins[h.win]! : pin.wins[h.win]!);
		const nm = (h: Hit) => (h.loop ? 'l' : '');
		// a two-piece window picks the piece by one compare against the boundary; an access that straddles it is checked
		// LIFT_MUTATE=swappieces picks the first piece for the second and the second for the first, which is unsound across a boundary
		const pick = (h: Hit, W: number) => {
			if (!winOf(h).two) return '';
			const [w0, w1] = mutate === 'swappieces' ? ['x', 'w'] : ['w', 'x'];
			return ` uint8_t* wp = AOT_PICK2(va, ${W}, ${nm(h)}va${h.win}, ${nm(h)}${w0}${h.win}, ${nm(h)}${w1}${h.win}, ${nm(h)}bd${h.win});`;
		};
		const have = (h: Hit) => (winOf(h).two ? 'wp != 0' : `${nm(h)}w${h.win} != 0`);
		const hitAt = (h: Hit, B: string, x: Ins) => (winOf(h).two ? 'wp' : `${nm(h)}w${h.win} + ${h.dyn ? `(${B} + ${imm64(x.imm)} - ${nm(h)}va${h.win})` : h.off}`);
		const hitCheck = (h: Hit, B: string, x: Ins) => {
			const w = winOf(h);
			const loop = h.loop ? `AOT_LCHK(&${R}_win[${w.ic}]); ${w.two ? `AOT_LCHK1(&${R}_win[${w.ic! + 1}], ${nm(h)}bd${h.win}); ` : ''}` : '';
			if (!h.dyn) return loop;
			return `${loop}AOT_WINCHK(${B} + ${imm64(x.imm)} - ${nm(h)}va${h.win}, ${Number(w.hi - w.lo) - x.w}u); `;
		};
		const soft = (h: Hit) => !!h.loop || (h.dyn && !pin.hard[h.win]);
		// --classes: each access reports its kind (0 window, 1 group, 2 checked, 3 slot in a local, 4 frame window), store or load, address and width to aot.h's AOT_CLS
		const cls = (site: number, kind: number, st: number, va: string, w: number) => (opt.classes ? `\tAOT_CLS(${site}, ${kind}, ${st}, ${va}, ${w});` : '');
		const hitStat = (site: number, h: Hit, st = 0, va = '0', w = 0) => ['\tAOT_STAT(win_acc, 1);', ...(h.dyn ? ['\tAOT_STAT(win_idx, 1);'] : []), ...(opt.classes ? [cls(site, 0, st, va, w)] : [])];
		// --bind: a checked access at a bound site tests its address against its mapping's bounds first, in locals the region
		// loaded when it was entered (flo, fsp, fh), or as constants under --bindconst; a miss takes the site's cache as before
		const flatOf = (site: number) => {
			const k = bound.get(site);
			if (k === undefined) return undefined;
			const f = flat[k]!;
			const t = opt.bindconst ? { lo: hex(f.lo), sp: hex(f.span), h: `AOT_HOST(${hex(f.lo)})` } : { lo: `flo${k}`, sp: `fsp${k}`, h: `fh${k}` };
			// --flat: sp is how many bytes an access may start in (16 less than the mapping), so one compare and no width
			// LIFT_MUTATE=flatlow32 compares the low 32 bits of the distance alone, so an address 4 GiB above the mapping hits it
			const dist = mutate === 'flatlow32' ? `(uint32_t) (va - ${t.lo})` : `va - ${t.lo}`;
			return { ...t, in: (W: number) => (flatFile ? `${dist} < ${t.sp}` : `va - ${t.lo} <= ${t.sp} - ${W}`), hit: flatFile ? 'AOT_STAT(flat_hit, 1); ' : '' };
		};
		// the checked copy of a load or store, closed by `close` on its last line
		const loadChk = (site: number, W: number, D: string, v: string, close: string) => {
			const f = flatOf(site);
			const head = `\t  AOT_STAT(chk_acc, 1);${cls(site, 2, 0, 'va', W)}`;
			if (f && opt.bindexit) return [head, `\t  if (__builtin_expect(${f.in(W)}, 1)) memcpy(&v, ${f.h} + (va - ${f.lo}), ${W}); else ${fault()}`, `\t  ${D} = ${v}; ${close}`];
			return [
				head,
				...(f
					? [
							'\t  int slow = 0;',
							`\t  if (__builtin_expect(${f.in(W)}, 1)) { ${f.hit}memcpy(&v, ${f.h} + (va - ${f.lo}), ${W}); }`,
							`\t  else { slow = AOT_SLOW(q, gen, va, ${W}); if (slow) v = kb_load_ic(cpu, q, va, ${W}); else memcpy(&v, q->host + (va - q->lo), ${W}); }`
						]
					: [`\t  int slow = __builtin_expect(AOT_SLOW(q, gen, va, ${W}), 0);`, `\t  if (slow) v = kb_load_ic(cpu, q, va, ${W}); else memcpy(&v, q->host + (va - q->lo), ${W});`]),
				`\t  ${D} = ${v};`,
				`\t  if (slow && cpu->fault) ${fault()} ${close}`
			];
		};
		const storeChk = (site: number, W: number, close: string) => {
			const f = flatOf(site);
			const head = `\t  AOT_STAT(chk_acc, 1);${cls(site, 2, 1, 'va', W)}`;
			if (f && opt.bindexit) return [head, `\t  if (__builtin_expect(${f.in(W)}, 1)) memcpy(${f.h} + (va - ${f.lo}), &v, ${W}); else ${fault()} ${close}`];
			const miss = `if (__builtin_expect(AOT_SLOW(q, gen, va, ${W}), 0)) { kb_store_ic(cpu, q, va, v, ${W}); if (cpu->fault) ${fault()} }`;
			return [
				head,
				...(f ? [`\t  if (__builtin_expect(${f.in(W)}, 1)) { ${f.hit}memcpy(${f.h} + (va - ${f.lo}), &v, ${W}); }`, `\t  else ${miss}`] : [`\t  ${miss}`]),
				`\t  else memcpy(q->host + (va - q->lo), &v, ${W}); ${close}`
			];
		};
		const revalidate = () => {
			if (!loops || mutate === 'noreval') return [];
			const ids = loopIds(loops, j);
			return ids.length ? [...openLoops(loops, ids), `\tAOT_STAT(win_enter, ${ids.length});`, '\tAOT_STAT(reval, 1);'] : [];
		};
		// the checked copy runs the block the fast body already counted
		body.push(`${label}: {`, `\tstruct kb_ic* ic = ${R}_blk[${j}]->ic;`, '\t(void) ic;', mode === 'slow' ? '\tAOT_STAT(win_slow, 1);' : `\tAOT_COUNT_BLOCK(${R}_blk[${j}]);`);
		if (temps.length) body.push(`\tuint64_t ${temps.map((r) => `g${r}`).join(', ')};`);
		if (pin.wins.length) {
			const key = sm ? -1 - j : j;
			let ics = winBase.get(key);
			if (ics === undefined) {
				ics = pin.wins.map((w) => {
					const at = windowCount;
					windowCount += w.two ? 2 : 1;
					return at;
				});
				winBase.set(key, ics);
			}
			const two = pin.wins.flatMap((w, k) => (w.two ? [k] : []));
			body.push(`\tuint8_t *${pin.wins.flatMap((_, k) => [`w${k}`, ...(two.includes(k) ? [`x${k}`] : [])]).join(', *')};`);
			const indexed = [...new Set([...pin.hits.values()].filter((h) => h.dyn).map((h) => h.win))];
			if (indexed.length) body.push(`\tuint64_t ${[...indexed.map((k) => `va${k}`), ...two.map((k) => `bd${k}`)].join(', ')};`);
			pin.wins.forEach((w, k) => body.push(...open(w, { w: `w${k}`, va: `va${k}`, x: `x${k}`, bd: `bd${k}` }, ics![k]!, indexed.includes(k))));
			const must = pin.wins.map((_, k) => k).filter((k) => pin.hard[k]);
			body.push(`\tAOT_STAT(win_enter, ${pin.wins.length});`);
			if (must.length) body.push(`\tif (!(${must.map((k) => `w${k}`).join(' && ')})) goto S${j};`);
		}
		b.ins.forEach((x, i) => {
			if (b.pcs) ipc = BigInt.asUintN(64, b.pc + BigInt(b.pcs[i]!));
			ipcNow = ipc;
			const [A, B, C, W] = [reg(x.a), reg(x.b), reg(x.c), x.w];
			const D = dst(x.a);
			const name = opName(x.op);
			const memop = name === 'LD' || name === 'LDS' || name === 'ST';
			let after: string[] = [];
			if (sm && memop) {
				const c: Cls | undefined = plan!.cls(j, i);
				const lo = frame.lo;
				const sl = c?.t === 'slot' ? plan!.slots[c.slot]! : undefined;
				const ext = (v: string) => (name === 'LDS' ? `(uint64_t) aot_sext(${v}, ${W})` : v);
				if (name !== 'ST' && sl) {
					if (V.has(sl.id)) body.push(`\t${D} = ${ext(`s${sl.id}`)};`, ...cnt('AOT_C_SLOT', 0), '\tAOT_STAT(win_acc, 1);', ...(opt.classes ? [cls(65535, 3, 0, `fl + ${sl.off - lo}`, W)] : []));
					else {
						body.push(`\t{ uint64_t v = 0; memcpy(&v, wf + ${sl.off - lo}, ${W}); s${sl.id} = v; ${D} = ${ext('v')}; }`, ...cnt('AOT_C_MEM', 0), '\tAOT_STAT(win_acc, 1);', ...(opt.classes ? [cls(65535, 4, 0, `fl + ${sl.off - lo}`, W)] : []));
						V.add(sl.id);
					}
					m++;
					return;
				}
				if (name !== 'ST' && c?.t === 'win') {
					body.push(`\t{ uint64_t v = 0; memcpy(&v, wf + ${c.off - lo}, ${W}); ${D} = ${ext('v')}; }`, ...cnt('AOT_C_MEM', 0), '\tAOT_STAT(win_acc, 1);', ...(opt.classes ? [cls(65535, 4, 0, `fl + ${c.off - lo}`, W)] : []));
					m++;
					return;
				}
				if (name === 'ST' && sl) {
					const write = mutate === 'nowrite' ? '' : `memcpy(wf + ${sl.off - lo}, &v, ${W}); `;
					body.push(`\t{ uint64_t v = ${A} & aot_mask(${W}); ${write}s${sl.id} = v; }`, ...cnt('AOT_C_SLOT', 1), '\tAOT_STAT(win_acc, 1);', ...(opt.classes ? [cls(65535, 4, 1, `fl + ${sl.off - lo}`, W)] : []));
					kill(plan!.overlapping(plan!.comp[j]!, sl.off, sl.w));
					V.add(sl.id);
					m++;
					return;
				}
				if (name === 'ST' && c?.t === 'win') {
					body.push(`\t{ uint64_t v = ${A}; memcpy(wf + ${c.off - lo}, &v, ${W}); }`, ...cnt('AOT_C_MEM', 1), '\tAOT_STAT(win_acc, 1);', ...(opt.classes ? [cls(65535, 4, 1, `fl + ${c.off - lo}`, W)] : []));
					kill(plan!.overlapping(plan!.comp[j]!, c.off, W));
					m++;
					return;
				}
				if (name === 'ST' && c) kill(c.t === 'part' ? c.kill : []);
				else if (name === 'ST') after = refresh(`(${B} + ${imm64(x.imm)})`, W);
			}
			if (slotted && memop) after.unshift(...cnt('AOT_C_MEM', name === 'ST' ? 1 : 0));
			switch (name) {
				case 'MOVI': body.push(`\t${D} = ${imm64(x.imm)};`); break;
				case 'MOV': body.push(`\t${D} = ${B};`); break;
				case 'ADD': body.push(`\t${D} = ${B} + ${C};`); break;
				case 'SUB': body.push(`\t${D} = ${B} - ${C};`); break;
				case 'AND': body.push(`\t${D} = ${B} & ${C};`); break;
				case 'OR': body.push(`\t${D} = ${B} | ${C};`); break;
				case 'XOR': body.push(`\t${D} = ${B} ^ ${C};`); break;
				case 'SHL': body.push(`\t${D} = ${C} >= 64 ? 0 : ${B} << ${C};`); break;
				case 'SHR': body.push(`\t${D} = ${C} >= 64 ? 0 : ${B} >> ${C};`); break;
				case 'SAR': body.push(`\t${D} = (uint64_t) ((int64_t) ${B} >> (${C} >= 64 ? 63 : ${C}));`); break;
				case 'ROR':
					body.push(`\t{ uint64_t v = ${B} & aot_mask(${W}), n = ${C} % ${8 * W}u; ${D} = n ? ((v >> n) | (v << (${8 * W} - n))) & aot_mask(${W}) : v; }`);
					break;
				case 'MUL': body.push(`\t${D} = ${B} * ${C};`); break;
				case 'UMULH': body.push(`\t${D} = kb_umulh(${B}, ${C});`); break;
				case 'SMULH': body.push(`\t${D} = kb_smulh(${B}, ${C});`); break;
				case 'UDIV': body.push(`\t${D} = ${C} ? ${B} / ${C} : 0;`); break;
				case 'SDIV':
					body.push(`\t${D} = ${C} ? ((int64_t) ${B} == INT64_MIN && (int64_t) ${C} == -1 ? ${B} : (uint64_t) ((int64_t) ${B} / (int64_t) ${C})) : 0;`);
					break;
				case 'UREM': body.push(`\t${D} = ${C} ? ${B} % ${C} : ${B};`); break;
				case 'SREM': body.push(`\t${D} = ${C} ? ((int64_t) ${C} == -1 ? 0 : (uint64_t) ((int64_t) ${B} % (int64_t) ${C})) : ${B};`); break;
				case 'ZEXT': body.push(`\t${D} = ${B} & aot_mask(${W});`); break;
				case 'SEXT': body.push(`\t${D} = (uint64_t) aot_sext(${B}, ${W});`); break;
				case 'INS':
					body.push(`\t{ uint64_t m = aot_mask(${W}) << ${x.imm}; ${D} = (${A} & ~m) | ((${B} << ${x.imm}) & m); }`);
					break;
				case 'LD':
				case 'LDS': {
					const v = name === 'LDS' ? `(uint64_t) aot_sext(v, ${W})` : 'v';
					const site = siteSeq++;
					if (opt.identity) {
						body.push(`\t{ uint64_t v = 0; memcpy(&v, AOT_HOST(${B} + ${imm64(x.imm)}), ${W}); ${D} = ${v}; }`);
						m++;
						break;
					}
					const hit = hitOf(i);
					if (hit && soft(hit)) {
						body.push(
							`\t{ uint64_t va = ${B} + ${imm64(x.imm)}, v = 0; struct kb_ic* q = &ic[${m}];${pick(hit, W)}`,
							`\t  if (__builtin_expect(${have(hit)}, 1)) { ${hitCheck(hit, B, x)}memcpy(&v, ${hitAt(hit, B, x)}, ${W}); ${D} = ${v}; ${hitStat(site, hit, 0, 'va', W).join(' ').replace(/\t/g, '')} } else {`,
							...(opt.plainchk ? [`\t  memcpy(&v, AOT_HOST(va), ${W}); ${D} = ${v}; } }`] : loadChk(site, W, D, v, '} }'))
						);
						m++;
						break;
					}
					if (hit) {
						body.push(`\t{ uint64_t v = 0; ${hitCheck(hit, B, x)}memcpy(&v, ${hitAt(hit, B, x)}, ${W}); ${D} = ${v}; }`, ...hitStat(site, hit, 0, `${B} + ${imm64(x.imm)}`, W));
						m++;
						break;
					}
					if (opt.plainchk) {
						body.push(`\t{ uint64_t v = 0; memcpy(&v, AOT_HOST(${B} + ${imm64(x.imm)}), ${W}); ${D} = ${v}; }`);
						m++;
						break;
					}
					// a grouped access reads through its group's resolved bytes when the span resolved
					const g = x.c - 1;
					const gr = grouped(x);
					// the interpreter writes a faulting load's destination before it checks, and so does this
					body.push(
						`\t{ uint64_t va = ${B} + ${imm64(x.imm)}, v = 0; struct kb_ic* q = &ic[${m}];`,
						...(gr ? [`\t  if (gh[${g}]) { AOT_STAT(grp_acc, 1);${cls(site, 1, 0, 'va', W)} memcpy(&v, gh[${g}] + (va - gva[${g}]), ${W}); ${D} = ${v}; } else {`] : []),
						...loadChk(site, W, D, v, `${gr ? '} ' : ''}}`)
					);
					m++;
					break;
				}
				case 'ST': {
					const site = siteSeq++;
					if (opt.identity) {
						body.push(`\t{ uint64_t v = ${A}; memcpy(AOT_HOST(${B} + ${imm64(x.imm)}), &v, ${W}); }`);
						m++;
						break;
					}
					const hit = hitOf(i);
					if (hit && soft(hit)) {
						body.push(
							`\t{ uint64_t va = ${B} + ${imm64(x.imm)}, v = ${A}; struct kb_ic* q = &ic[${m}];${pick(hit, W)}`,
							`\t  if (__builtin_expect(${have(hit)}, 1)) { ${hitCheck(hit, B, x)}memcpy(${hitAt(hit, B, x)}, &v, ${W}); ${hitStat(site, hit, 1, 'va', W).join(' ').replace(/\t/g, '')} } else {`,
							...(opt.plainchk ? [`\t  memcpy(AOT_HOST(va), &v, ${W}); } }`] : storeChk(site, W, '} }'))
						);
						m++;
						break;
					}
					if (hit) {
						body.push(`\t{ uint64_t v = ${A}; ${hitCheck(hit, B, x)}memcpy(${hitAt(hit, B, x)}, &v, ${W}); }`, ...hitStat(site, hit, 1, `${B} + ${imm64(x.imm)}`, W));
						m++;
						break;
					}
					if (opt.plainchk) {
						body.push(`\t{ uint64_t v = ${A}; memcpy(AOT_HOST(${B} + ${imm64(x.imm)}), &v, ${W}); }`);
						m++;
						break;
					}
					const g = x.c - 1;
					const gr = grouped(x);
					body.push(
						`\t{ uint64_t va = ${B} + ${imm64(x.imm)}, v = ${A}; struct kb_ic* q = &ic[${m}];`,
						...(gr ? [`\t  if (gh[${g}]) { AOT_STAT(grp_acc, 1);${cls(site, 1, 1, 'va', W)} memcpy(gh[${g}] + (va - gva[${g}]), &v, ${W}); } else {`] : []),
						...storeChk(site, W, `${gr ? '} ' : ''}}`)
					);
					m++;
					break;
				}
				case 'RESOLVE':
					// the whole span, range included: AOT_NO_RANGE_CHECK trusts accesses, never a span
					if (!opt.nogroups && !opt.identity && !fast)
						body.push(
							`\t{ uint64_t va = ${B} + ${imm64(x.imm)}; struct kb_ic* q = &ic[${m}]; gva[${x.a}] = va;`,
							`\t  gh[${x.a}] = ${G}${16 * W}u <= q->span && va - q->lo <= q->span - ${16 * W}u ? q->host + (va - q->lo) : kb_host_ic_at(cpu, q, va, ${16 * W}u, ${rights(b.ins.some((y) => opName(y.op) === 'ST' && y.c === x.a + 1))}); }`
						);
					m++;
					break;
				case 'FLAGS':
					if (!dead.has(`${j}:${i}`)) body.push(`\taot_flags(&f, ${x.imm}, ${B}, ${C}, ${A}, ${W});`);
					break;
				case 'SETCC': body.push(`\t${D} = (uint64_t) aot_cond(&f, ${x.imm});`); break;
				case 'SEL': body.push(`\t${D} = aot_cond(&f, ${x.imm}) ? ${B} : ${C};`); break;
				case 'BR': body.push(`\tif (aot_cond(&f, ${x.imm})) ${leave(b.pc, b.target, i)}`); break;
				case 'BRZ': body.push(`\tif ((${A} != 0) == ${x.imm !== 0n ? 1 : 0}) ${leave(b.pc, b.target, i)}`); break;
				case 'EXIT': {
					const to = BigInt.asUintN(64, b.pc + BigInt.asIntN(32, x.imm >> 16n));
					const cond = x.imm & 0x100n ? `(${A} == 0) == ${x.imm & 1n ? 0 : 1}` : `aot_cond(&f, ${x.imm & 0xffn})`;
					body.push(`\tif (${cond}) ${leave(b.pc, to, i)}`);
					break;
				}
				case 'JMP': {
					// a jump to a constant is an edge like a branch's (the slots form follows it without the switch)
					const k = constJump(b);
					const to = k !== undefined && calls.has(k) ? k : slotted ? plan?.sym[j]?.exits.find((e) => e.i === i)?.to : undefined;
					if (to !== undefined && to !== null) body.push(`\t${leave(b.pc, to, i)}`);
					else body.push(`\tpc = ${B}; if (AOT_CONTINUE(1, pc <= ${hex(b.pc)})) goto dispatch; goto out;`);
					break;
				}
				case 'PC': ipc = x.imm; break;
				case 'CARRY': body.push(`\t${D} = (uint64_t) f.c;`); break;
				case 'BSWAP': body.push(`\t${D} = __builtin_bswap64(${B}) >> ${64 - 8 * W};`); break;
				case 'CLZ':
					body.push(`\t{ uint64_t v = ${B} & aot_mask(${W}); ${D} = v ? (uint64_t) (__builtin_clzll(v) - ${64 - 8 * W}) : ${8 * W}u; }`);
					break;
				case 'CTZ': body.push(`\t{ uint64_t v = ${B} & aot_mask(${W}); ${D} = v ? (uint64_t) __builtin_ctzll(v) : ${8 * W}u; }`); break;
				case 'POPCNT': body.push(`\t${D} = (uint64_t) __builtin_popcountll(${B} & aot_mask(${W}));`); break;
				case 'FSBASE':
					if (precise) body.push(`\t${D} = gfs;`);
					else body.push(`\t${D} = cpu->fs;`, '\tAOT_COUNT_RDC(AOT_C_FS, 1);');
					break;
				case 'X86MD': body.push(`\tif (aot_muldiv(&g0, &g2, &f, ${x.imm}, ${W}, ${B})) ${fault('divide error', 8)}`); break;
				case 'X86SHD':
					body.push(
						`\t{ uint64_t m = aot_mask(${W}), v = ${A} & m, in = ${B} & m, n = ${C}, o, cf;`,
						`\t  if (n) { ${x.imm === 0n ? `o = n == ${8 * W} ? in : ((v << n) | (in >> (${8 * W} - n))) & m; cf = (v >> (${8 * W} - n)) & 1;` : `o = ((v >> n) | (in << (${8 * W} - n))) & m; cf = (v >> (n - 1)) & 1;`}`,
						`\t    ${D} = o; aot_flags(&f, KB_F_LOGIC, o, o, o, ${W}); f.c = (int) cf; } }`
					);
					break;
				case 'X86FLAGS':
					if (x.imm === 0n)
						body.push(`\t${D} = 0x202 | (uint64_t) f.c | ((uint64_t) f.p << 2) | ((uint64_t) f.z << 6) | ((uint64_t) f.n << 7) | ((uint64_t) df << 10) | ((uint64_t) f.v << 11);`);
					else if (x.imm === 1n)
						body.push(`\t{ uint64_t v = ${A}; f.c = (int) (v & 1); f.p = (int) ((v >> 2) & 1); f.z = (int) ((v >> 6) & 1); f.n = (int) ((v >> 7) & 1); f.v = (int) ((v >> 11) & 1); df = (int) ((v >> 10) & 1); }`);
					else body.push(`\t${['f.c = !f.c;', 'f.c = 0;', 'f.c = 1;', 'df = 0;'][Number(x.imm) - 2] ?? 'df = 1;'}`);
					break;
				case 'SSE':
				case 'X87': {
					const call = name === 'SSE' ? 'kb_sse' : 'kb_x87';
					const cat = name === 'SSE' ? 'AOT_C_SSE' : 'AOT_C_X87';
					const run = `\tif (${call}(cpu, &${R}_blk[${j}]->ins[${i}]) && !cpu->fault) { cpu->fault = "unknown ${name.toLowerCase()} instruction"; cpu->fault_sig = 4; }`;
					if (precise) {
						const t = touches(x);
						spillTouch(t, cat);
						body.push(run);
						reloadTouch(t, cat);
						body.push(`\tif (cpu->fault) { cpu->ipc = ${hex(ipc)}; pc = ${hex(b.pc)}; goto out; }`);
						// a memory operand may be written (xmm or x87 stores, fxsave): kill the slots it names, or check an unknown address
						const wide = vecWrite(name, x);
						if (sm && wide) {
							const c = plan!.cls(j, i);
							if (c) kill(c.t === 'vec' ? c.kill : []);
							else after = refresh(B, wide);
						}
						break;
					}
					// a helper reads its address from the cpu; a temporary base is spilled for it alone
					spill(isTemp(x.b) && !cross(x.b) ? [x.b] : [], cat);
					body.push(run, `\tif (cpu->fault) { cpu->ipc = ${hex(ipc)}; return ${hex(b.pc)}; }`);
					reload(cat);
					break;
				}
				case 'X86STR':
					if (precise) {
						const t = touches(x);
						const known = sm && V.size && !x.c && regList.includes(7);
						if (known) body.push(`\tuint64_t sva${i} = g7;`);
						spillTouch(t, 'AOT_C_STR');
						body.push(`\tkb_aot_string(cpu, ${x.imm}, ${W}, ${x.c});`);
						reloadTouch(t, 'AOT_C_STR');
						body.push(`\tif (cpu->fault) { cpu->ipc = ${hex(ipc)}; pc = ${hex(b.pc)}; goto out; }`);
						// rep movs and stos write a range: read every slot again; a single one is checked by its address
						if (known) after = refresh(`sva${i}`, W);
						else if (sm && V.size && mutate !== 'noguard') after = [`\t{ ${[...V].map(slotLoad).join(' ')} AOT_COUNT_CAT(AOT_C_FIX, 1, ${V.size}); }`];
						break;
					}
					spill([], 'AOT_C_STR');
					body.push(`\tkb_aot_string(cpu, ${x.imm}, ${W}, ${x.c});`, `\tif (cpu->fault) { cpu->ipc = ${hex(ipc)}; return ${hex(b.pc)}; }`);
					reload('AOT_C_STR');
					break;
				case 'SYSCALL':
					// a syscall that ends the block leaves the region; one in the middle would have to check the epoch
					if (opt.epochs && i !== b.ins.length - 1) throw new Error(`--epochs: syscall inside block ${b.pc.toString(16)}`);
					spill([], 'AOT_C_SYS');
					body.push(
						`\tcpu->pc = ${hex(b.next)};`,
						'\tAOT_COUNT_RDC(AOT_C_SYS, 2); AOT_COUNT_WRC(AOT_C_SYS, 1);',
						'\tkb_syscall(cpu);',
						'\tif (cpu->exited) return 0;',
						'\tif (cpu->sigreturned) { cpu->sigreturned = 0; return cpu->pc; }',
						`\tif (cpu->fault) { cpu->ipc = ${hex(ipc)}; return ${hex(b.pc)}; }`
					);
					if (i === b.ins.length - 1) body.push(`\treturn ${hex(b.next)};`);
					else {
						reload('AOT_C_SYS');
						body.push(...revalidate());
					}
					break;
				default:
					throw new Error(`no lifting for ${name}`);
			}
			body.push(...after);
		});
		const lastOp = opName(b.ins.at(-1)!.op);
		if (lastOp !== 'JMP' && !(lastOp === 'SYSCALL')) body.push(`\t${leave(b.pc, b.next, -1)}`);
		body.push('}');
		return body;
	};

	const twins = new Set<number>();
	// a promoted block's entry from outside its frame: find the frame window, then load what the block needs
	const stub = (j: number) => {
		const c = plan!.comp[j]!;
		const { lo, hi } = plan!.wins[c]!;
		const len = hi - lo;
		const loads = plan!.need[j]!.map((id) => {
			const s = plan!.slots[id]!;
			return `\ts${id} = 0; memcpy(&s${id}, wf + ${s.off - lo}, ${s.w});`;
		});
		return [
			`E${j}: {`,
			`\tfb = g${SP} - ${imm64(BigInt(plan!.at[j]!))};`,
			`\tfl = fb + ${imm64(BigInt(lo))};`,
			opt.identity
				? '\twf = AOT_HOST(fl);'
				: `\t{ struct kb_ic* q = &${R}_fw[${c}]; wf = ${G}${len}u <= q->span && fl - q->lo <= q->span - ${len}u ? q->host + (fl - q->lo) : kb_host_ic_at(cpu, q, fl, ${len}u, ${rights(true)}); }`,
			`\tif (!wf) goto S${j};`,
			...loads,
			`\tAOT_COUNT_CAT(AOT_C_FIX, 0, ${loads.length});`,
			'\tAOT_STAT(win_enter, 1);',
			`\tgoto B${j};`,
			'}'
		];
	};
	// a direct call: the callee's body runs inline on the caller's locals, handed in through its io struct and back
	// after, so no register or flag goes through the cpu. The callee leaves through its out with the pc it stopped at:
	// a pc that is one of this region's blocks continues there (a pushed return address first), any other pc (a signal,
	// a fault, a jump elsewhere) leaves through this region's out
	const callSite = (b: Block, j: number, to: bigint, precise: boolean, slotted: boolean) => {
		const C = info[calls.get(to)!]!;
		const form = only !== undefined ? '' : slotted ? (C.slotted ? 's' : 'p') : precise ? 'p' : '';
		// the return addresses the block pushed (constants that are a block of this region), checked before the switch
		const pushed = [...new Set(b.ins.filter((x) => opName(x.op) === 'MOVI').map((x) => BigInt.asUintN(64, x.imm)))].filter((v) => index.has(v));
		// the callee may have written any frame slot through a pointer, so a promoted return site is entered through its stub
		const resume = pushed.map((v) => {
			const k = index.get(v)!;
			// back from the callee the loop's windows are resolved again
			const back = opt.loops && mutate !== 'noreval' && loopIds(loopData(slotted), k).length ? 'L' : '';
			return `\tif (pc == ${hex(v)} && AOT_CONTINUE(${R}_ok[${k}], ${v <= b.pc ? 1 : 0})) goto ${back}${slotted && plan!.promoted[k] ? 'E' : 'B'}${k};`;
		});
		return [
			`K${j}_${to.toString(16)}: {`,
			`\tstruct ${C.name}_io io = {${C.regList.map((r) => `.g${r} = g${r}`).join(', ')}, .n = f.n, .z = f.z, .c = f.c, .v = f.v, .p = f.p, .df = df, ${opt.epochs ? '.ep = ep' : '.gen = gen'}${precise ? ', .gfs = gfs' : ''}};`,
			'\tAOT_COUNT_CAT(AOT_C_CALL, 0, 1);',
			`\tpc = ${C.name}${form}_go(cpu, ${hex(to)}, &io);`,
			...(mutate === 'noreturn' ? [] : C.regList.map((r) => `\tg${r} = io.g${r};`)),
			`\tf.n = io.n; f.z = io.z; f.c = io.c; f.v = io.v; f.p = io.p; df = io.df;${opt.epochs ? '' : ' gen = io.gen;'}`,
			...(precise ? ['\tgfs = io.gfs;'] : []),
			...resume,
			'\tif (AOT_CONTINUE(1, 1)) goto dispatch;',
			'\tgoto out;',
			'}'
		];
	};
	const bodyOf = (precise: boolean, slotted = false) => {
		const body: string[] = [];
		chosen.forEach((b, j) => {
			edges.clear();
			const ld = opt.loops ? loopData(slotted) : undefined;
			const lhits = ld?.hits.get(j);
			if (ld && ld.chain[j]!.length) {
				const ids = loopIds(ld, j);
				const enter = (label: string) => [`L${label}${j}: {`, ...openLoops(ld, ids), `\tAOT_STAT(win_enter, ${ids.length});`, `\tgoto ${label}${j};`, '}'];
				body.push(...enter('B'), ...(slotted && plan!.promoted[j] ? enter('E') : []));
			}
			const own = windowsOf(b, false, lhits && new Set(lhits.keys()));
			if (slotted && plan!.promoted[j]) body.push(...stub(j), ...emit(b, j, 'fast', precise, true), ...emit(b, j, 'slow', precise, true));
			else if (opt.windows && (own.wins.length || lhits?.size)) {
				// a block whose windows all fall back access by access has no checked copy to leave to
				if (own.hard.some(Boolean)) {
					twins.add(j);
					body.push(...emit(b, j, 'fast', precise, slotted), ...emit(b, j, 'slow', precise, slotted));
				} else body.push(...emit(b, j, 'fast', precise, slotted));
			} else body.push(...emit(b, j, 'plain', precise, slotted));
			for (const to of edges) body.push(...callSite(b, j, to, precise, slotted));
		});
		return body;
	};
	chosen.forEach((b) => (irIns += b.ins.length));
	// the forms emitted: all the flags allow, or the one --only names (form 2 with no slot plan is form 1)
	const forms = only === undefined ? [0, ...(opt.regs ? [1] : []), ...(plan ? [2] : [])] : [only === 2 && !plan ? 1 : only];
	const body = forms.includes(0) ? bodyOf(false) : [];
	const bodyP = forms.includes(1) ? bodyOf(true) : [];
	const bodyS = forms.includes(2) ? bodyOf(true, true) : [];

	chosen.forEach((b, j) => {
		lines.push(`static const struct kb_ins ${R}_i${j}[] = {`);
		for (const x of b.ins) lines.push(`\t{${x.op}, ${x.w}, ${x.a}, ${x.b}, ${x.c}, (int64_t) ${hex(x.imm)}},`);
		lines.push('};');
		if (b.pcs) lines.push(`static const uint32_t ${R}_p${j}[] = {${b.pcs.map((v) => `${v >>> 0}u`).join(', ')}};`);
		table.push({ pc: b.pc, next: b.next, target: b.target, n: b.ins.length, region, idx: j, name: `${R}_i${j}`, pcs: b.pcs ? `${R}_p${j}` : 'NULL' });
	});
	lines.push(`static unsigned char ${R}_ok[${chosen.length}];`, `static struct kb_block* ${R}_blk[${chosen.length}];`);
	if (opt.windows) lines.push(`static struct kb_ic ${R}_win[${Math.max(1, windowCount)}];`);
	if (plan) lines.push(`static struct kb_ic ${R}_fw[${plan.wins.length}];`);
	if (opt.epochs) {
		// zeroed windows hold no span, so they miss; a block's caches go back to the interpreter's cold value
		lines.push(`static uint32_t ${R}_ep, ${R}_mg;`, `static void ${R}_cold(void) {`);
		if (opt.windows) lines.push(`\tmemset(${R}_win, 0, sizeof ${R}_win);`);
		if (plan) lines.push(`\tmemset(${R}_fw, 0, sizeof ${R}_fw);`);
		lines.push(
			`\tfor (int j = 0; j < ${chosen.length}; j++)`,
			`\t\tfor (int i = 0; ${R}_blk[j] && i < ${R}_blk[j]->nic; i++) ${R}_blk[j]->ic[i] = (struct kb_ic) {0, AOT_COLD, NULL, 0};`,
			'}'
		);
	}
	lines.push('');

	const inner = called.has(region);
	if (inner)
		lines.push(`struct ${R}_io {`, ...regList.map((r) => `\tuint64_t g${r};`), '\tint n, z, c, v, p, df;', opt.epochs ? '\tuint32_t ep;' : '\tuint32_t gen;', '\tuint64_t gfs;', '};', '');
	const fn = (precise: boolean, text: string[], slotted = false) => {
		const tag = only !== undefined ? '' : slotted ? 's' : precise ? 'p' : '';
		// a region that is called directly has a `go` that takes its state from the io struct (or the cpu, when the
		// interpreter enters it) and leaves it there; the aot_run entry wraps it
		lines.push(
			inner
				? `static ${opt.noinline ? '__attribute__((noinline))' : 'inline __attribute__((always_inline))'} uint64_t ${R}${tag}_go(struct kb_cpu* cpu, uint64_t pc, struct ${R}_io* io) {`
				: `static uint64_t ${R}${tag}_run(struct kb_cpu* cpu, uint64_t pc) {`
		);
		const from = (io: string, c: string) => (inner ? `io ? ${io} : ${c}` : c);
		lines.push(...regList.map((r) => `\tuint64_t g${r} = ${from(`io->g${r}`, `cpu->r[${r}]`)};`));
		lines.push(
			'\tuint64_t sink = 0;',
			inner ? '\tstruct aot_fl f = io ? (struct aot_fl) {io->n, io->z, io->c, io->v, io->p} : (struct aot_fl) {cpu->n, cpu->z, cpu->c, cpu->v, cpu->p};' : '\tstruct aot_fl f = {cpu->n, cpu->z, cpu->c, cpu->v, cpu->p};',
			'\tuint8_t* gh[8];',
			'\tuint64_t gva[8];',
			'\t(void) gh;',
			'\t(void) gva;',
			`\tint df = ${from('io->df', 'cpu->df')};`,
			...(opt.epochs ? [`\tuint32_t ep = ${from('io->ep', 'kb_epoch')};`] : [`\tuint32_t gen = ${from('io->gen', 'cpu->mapgen')};`, '\tint fuel = KB_POLL_FUEL;']),
			'\t(void) sink;',
			...(opt.epochs ? [] : ['\t(void) fuel;'])
		);
		if (bindFile && !opt.bindconst)
			flat.forEach((_, k) => lines.push(`\tuint64_t flo${k} = aot_flat[${k}][0], fsp${k} = aot_flat[${k}][1];`, `\tuint8_t* fh${k} = AOT_HOST(flo${k});`, `\t(void) flo${k}; (void) fsp${k}; (void) fh${k};`));
		if (opt.loops)
			loopData(!!slotted).wins.forEach((w, g) =>
				lines.push(
					`\t${mutate === 'noreval' ? 'static ' : ''}uint8_t *lw${g} = 0${w.two ? `, *lx${g} = 0` : ''};`,
					`\t${mutate === 'noreval' ? 'static ' : ''}uint64_t lva${g} = 0${w.two ? `, lbd${g} = 0` : ''};`,
					`\t(void) lw${g};`,
					`\t(void) lva${g};`
				)
			);
		// the region's caches are checked against the mapping generation when kb_epoch has moved since the last entry
		// LIFT_MUTATE=noepoch never makes them cold, so a cache from before a remap is trusted
		if (opt.epochs && mutate !== 'noepoch') lines.push('\tAOT_STAT(ep_in, 1);', `\tif (__builtin_expect(${R}_ep != ep, 0)) { AOT_STAT(ep_slow, 1); if (${R}_mg != cpu->mapgen) { ${R}_cold(); ${R}_mg = cpu->mapgen; }${flat.length && flatFile ? ' aot_flat_sync(cpu);' : ''} ${R}_ep = ep; }`);
		// --flat: the table is current once the slow path above has run, so the bounds are read after it
		if (flatFile)
			flat.forEach((_, k) => lines.push(`\tuint64_t flo${k} = aot_flat[${k}].lo, fsp${k} = aot_flat[${k}].lim;`, `\tuint8_t* fh${k} = aot_flat[${k}].host;`, `\t(void) flo${k}; (void) fsp${k}; (void) fh${k};`));
		if (precise) lines.push(`\tuint64_t gfs = ${from('io->gfs', 'cpu->fs')};`, '\t(void) gfs;');
		if (slotted) {
			lines.push('\tuint64_t fb = 0, fl = 0;', '\tuint8_t* wf = NULL;', '\t(void) fb;', '\t(void) fl;', '\t(void) wf;');
			for (const s of plan!.slots) lines.push(`\tuint64_t s${s.id} = 0;`, `\t(void) s${s.id};`);
		}
		const entry = `AOT_COUNT_RDC(AOT_C_REGION, ${regList.length + 7 + (precise ? 1 : 0) - (opt.epochs ? 1 : 0)});`;
		lines.push(inner ? `\tif (!io) ${entry}` : `\t${entry}`, '\tgoto dispatch;', 'dispatch:', '\tswitch (pc) {');
		const into = (j: number) => (opt.loops && loopData(!!slotted).chain[j]!.length ? 'L' : '');
		chosen.forEach((b, j) => lines.push(`\t\tcase ${hex(b.pc)}: if (${R}_ok[${j}]) goto ${into(j)}${slotted && plan!.promoted[j] ? 'E' : 'B'}${j}; goto out;`));
		lines.push('\t\tdefault: goto out;', '\t}');
		for (const t of text) lines.push(t);
		const cpuOut = [
			`AOT_COUNT_WRC(AOT_C_REGION, ${regList.length + 6});`,
			'AOT_COUNT_EXIT(pc);',
			...regList.map((r) => `cpu->r[${r}] = g${r};`),
			'cpu->n = f.n; cpu->z = f.z; cpu->c = f.c; cpu->v = f.v; cpu->p = f.p; cpu->df = df;'
		];
		lines.push('out:');
		if (inner)
			lines.push(
				'\tif (io) {',
				...regList.map((r) => `\t\tio->g${r} = g${r};`),
				'\t\tio->n = f.n; io->z = f.z; io->c = f.c; io->v = f.v; io->p = f.p; io->df = df;' + (opt.epochs ? '' : ' io->gen = gen;'),
				...(precise ? ['\t\tio->gfs = gfs;'] : []),
				'\t} else {',
				...cpuOut.map((l) => `\t\t${l}`),
				'\t}'
			);
		else lines.push(...cpuOut.map((l) => `\t${l}`));
		lines.push('\treturn pc;', '}');
		if (inner) lines.push(`static uint64_t ${R}${tag}_run(struct kb_cpu* cpu, uint64_t pc) {`, `\treturn ${R}${tag}_go(cpu, pc, NULL);`, '}');
		lines.push('');
	};
	if (forms.includes(0)) fn(false, body);
	if (forms.includes(1)) fn(true, bodyP);
	regionSlotted[region] = !!plan;
	if (forms.includes(2)) fn(true, bodyS, true);
	info[region] = { name: R, regList, index, slotted: !!plan };
	const memOps = chosen.reduce((n, b) => n + b.ins.filter((x) => ['LD', 'LDS', 'ST'].includes(opName(x.op))).length, 0);
	const hitsOf = opt.windows ? chosen.map((b) => [...windowsOf(b).hits.values()]) : [];
	const windowed = hitsOf.reduce((n, h) => n + h.length, 0);
	const indexed = hitsOf.reduce((n, h) => n + h.filter((x) => x.dyn).length, 0);
	console.error(`${R}: ${memOps} loads and stores, ${windowed} in windows resolved once per block entry${indexed ? ` (${indexed} with an index bound)` : ''}, ${memOps - windowed} checked at each access`);
	if (opt.loops)
		for (const s of new Set(forms.map((f) => f === 2))) {
			const ld = loopData(s);
			const through = [...ld.hits.values()].reduce((n, h) => n + h.size, 0);
			const two = ld.wins.filter((w) => w.two).length;
			console.error(`${R}: ${nest.loops.length} loops, ${ld.byLoop.size} with windows, ${ld.wins.length} loop windows${two ? ` (${two} of two pieces)` : ''}, ${through} loads and stores through them${s ? ' (slots form)' : ''}`);
		}
	console.error(`${R}: ${regList.length} region registers, ${twins.size} blocks with windows, ${windowCount} windows so far`);
});

table.sort((a, b) => (a.pc < b.pc ? -1 : a.pc > b.pc ? 1 : 0));
lines.push(
	'static const struct aot_entry aot_table[] = {',
	...table.map((e) => `\t{${hex(e.pc)}, ${hex(e.next)}, ${hex(e.target)}, ${e.n}, ${e.region}, ${e.idx}, ${e.name}, ${e.pcs}},`),
	'};',
	`static unsigned char* const aot_ok[] = {${regionNames.map((n) => n.replace('_run', '_ok')).join(', ')}};`,
	`static struct kb_block** const aot_blk[] = {${regionNames.map((n) => n.replace('_run', '_blk')).join(', ')}};`,
	`static const int aot_n[] = {${regionSizes.join(', ')}};`,
	`static uint64_t (*const aot_run[])(struct kb_cpu*, uint64_t) = {${regionNames.join(', ')}};`,
	...(opt.regs && !oneForm ? [`static uint64_t (*const aot_runp[])(struct kb_cpu*, uint64_t) = {${regionNames.map((n) => n.replace('_run', 'p_run')).join(', ')}};`] : []),
	...(opt.slots && !oneForm ? [`static uint64_t (*const aot_runs[])(struct kb_cpu*, uint64_t) = {${regionNames.map((n, k) => n.replace('_run', regionSlotted[k] ? 's_run' : 'p_run')).join(', ')}};`] : []),
	'',
	'void kb_aot_detach(struct kb_block* b) {',
	`\tfor (int r = 0; r < ${regionNames.length}; r++)`,
	'\t\tfor (int i = 0; i < aot_n[r]; i++)',
	'\t\t\tif (aot_blk[r][i] == b) {',
	'\t\t\t\taot_ok[r][i] = 0;',
	'\t\t\t\taot_blk[r][i] = NULL;',
	'\t\t\t}',
	'}',
	'',
	'void kb_aot_attach(struct kb_cpu* cpu, struct kb_block* b) {',
	'\t(void) cpu;',
	`\tint lo = 0, hi = ${table.length};`,
	'\twhile (lo < hi) {',
	'\t\tint mid = (lo + hi) / 2;',
	'\t\tif (aot_table[mid].pc < b->pc) lo = mid + 1; else hi = mid;',
	'\t}',
	`\tfor (int k = lo; k < ${table.length} && aot_table[k].pc == b->pc; k++) {`,
	'\t\tconst struct aot_entry* e = &aot_table[k];',
	'\t\tif (e->next != b->next || e->target != b->target || e->n != b->n) continue;',
	'\t\tint same = 1;',
	'\t\tfor (int i = 0; same && i < e->n; i++) {',
	'\t\t\tconst struct kb_ins *x = &e->ins[i], *y = &b->ins[i];',
	'\t\t\tsame = x->op == y->op && x->w == y->w && x->a == y->a && x->b == y->b && x->c == y->c && x->imm == y->imm;',
	'\t\t}',
	'\t\tif (!same) continue;',
	'\t\tif (e->pcs && b->pcs && memcmp(e->pcs, b->pcs, (size_t) e->n * sizeof *e->pcs)) continue;',
	'\t\taot_ok[e->region][e->idx] = 1;',
	'\t\taot_blk[e->region][e->idx] = b;',
	oneForm
		? '\t\tb->aot = aot_run[e->region];'
		: opt.slots
		? '\t\tb->aot = aot_regs() == 2 ? aot_runs[e->region] : aot_regs() ? aot_runp[e->region] : aot_run[e->region];'
		: opt.regs
			? '\t\tb->aot = aot_regs() ? aot_runp[e->region] : aot_run[e->region];'
			: '\t\tb->aot = aot_run[e->region];',
	'\t\treturn;',
	'\t}',
	'}'
);
writeFileSync(out, `${lines.join('\n')}\n`);
console.error(`wrote ${out}: ${table.length} blocks in ${regionNames.length} regions, ${irIns} IR ops (${irIns * 16} bytes), ${windowCount} windows`);
