import { readFileSync, writeFileSync } from 'node:fs';

/**
 * The AOT oracle's lifter: turns the hottest blocks of each KATYBUG_HOT dump into C, one region per
 * dump (one process), which clang then compiles into katybug.wasm with -DKB_AOT. A region holds guest
 * registers and flags in locals and moves between its blocks with goto; everything else leaves to the
 * interpreter. A decoded block runs a region only if its IR matches the lifted one exactly
 * (kb_aot_attach), so the guard is the IR itself.
 *
 * `lift.ts <out.c> <coverage 0..1> <dump.hot>...`
 */
const [out = '', coverageArg = '0.99', ...dumps] = process.argv.slice(2);
const coverage = Number(coverageArg);
const root = new URL('../../../', import.meta.url).pathname;

// the IR's op numbers, in kb.h's order
const header = readFileSync(`${root}src/gmux/katybug/kb.h`, 'utf8');
const opBody = header.match(/enum kb_op\s*\{([\s\S]*?)\};/)![1]!.replace(/\/\*[\s\S]*?\*\//g, '');
const OPS = opBody
	.split(',')
	.map((s) => s.trim())
	.filter(Boolean);
const op = Object.fromEntries(OPS.map((name, i) => [name.replace(/^KB_/, ''), i])) as Record<string, number>;
const KB_ZERO = 63;

interface Ins {
	op: number;
	w: number;
	a: number;
	b: number;
	c: number;
	imm: bigint;
}
interface Block {
	pc: bigint;
	next: bigint;
	target: bigint;
	runs: bigint;
	ins: Ins[];
}

function parse(path: string): Block[] {
	const lines = readFileSync(path, 'utf8').split('\n');
	const blocks: Block[] = [];
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i]!.match(/^block (\w+) (\w+) (\w+) (\d+) (\d+)$/);
		if (!m) continue;
		const n = Number(m[4]);
		const ins: Ins[] = [];
		for (let k = 1; k <= n; k++) {
			const f = lines[i + k]!.split(' ');
			ins.push({ op: +f[0]!, w: +f[1]!, a: +f[2]!, b: +f[3]!, c: +f[4]!, imm: BigInt(f[5]!) });
		}
		blocks.push({ pc: BigInt(`0x${m[1]}`), next: BigInt(`0x${m[2]}`), target: BigInt(`0x${m[3]}`), runs: BigInt(m[5]!), ins });
		i += n;
	}
	return blocks;
}

// ops a region cannot run: AArch64-only state and traps stay with the interpreter
const unliftable = new Set(['TRAP', 'WTRAP', 'WEXIT', 'CCMP', 'TPIDR', 'SETTP'].map((n) => op[n]!));
const liftable = (b: Block) => b.ins.every((x) => !unliftable.has(x.op));
const hex = (v: bigint) => `0x${BigInt.asUintN(64, v).toString(16)}ull`;
const imm64 = (v: bigint) => `(uint64_t) ${hex(v)}`;

const lines: string[] = ['#include <string.h>', '#include "aot.h"', ''];
const table: { pc: bigint; next: bigint; target: bigint; n: number; region: number; idx: number; name: string }[] = [];
const regionNames: string[] = [];

dumps.forEach((dump, region) => {
	const all = parse(dump);
	const weight = (b: Block) => b.runs * BigInt(b.ins.length);
	const total = all.reduce((s, b) => s + weight(b), 0n);
	const sorted = [...all].sort((x, y) => (weight(y) > weight(x) ? 1 : weight(y) < weight(x) ? -1 : 0));
	const chosen: Block[] = [];
	let covered = 0n;
	for (const b of sorted) {
		if (Number(covered) >= coverage * Number(total)) break;
		if (!liftable(b)) continue;
		chosen.push(b);
		covered += weight(b);
	}
	const share = Number(covered) / Number(total);
	console.error(`${dump}: ${all.length} blocks, ${chosen.length} lifted, ${(100 * share).toFixed(2)}% of executed ops`);

	const R = `r${region}`;
	regionNames.push(`${R}_run`);
	const index = new Map(chosen.map((b, j) => [b.pc, j]));
	// the fields that name registers: SSE and x87 carry an xmm index and a memory marker in a and c,
	// and string ops read theirs through the cpu after the spill
	const registerFields = (x: Ins) => {
		const name = OPS[x.op]!.replace(/^KB_/, '');
		if (name === 'SSE' || name === 'X87') return [x.b];
		if (name === 'X86STR' || name === 'PC' || name === 'SYSCALL') return [];
		return [x.a, x.b, x.c];
	};
	const regs = new Set<number>([0, 2]);
	for (const b of chosen) for (const x of b.ins) for (const r of registerFields(x)) if (r !== KB_ZERO) regs.add(r);
	const reg = (r: number) => (r === KB_ZERO ? '(uint64_t) 0' : `g${r}`);
	const dst = (r: number) => (r === KB_ZERO ? 'sink' : `g${r}`);
	const regList = [...regs].sort((a, b) => a - b);

	chosen.forEach((b, j) => {
		lines.push(`static const struct kb_ins ${R}_i${j}[] = {`);
		for (const x of b.ins) lines.push(`\t{${x.op}, ${x.w}, ${x.a}, ${x.b}, ${x.c}, (int64_t) ${hex(x.imm)}},`);
		lines.push('};');
		table.push({ pc: b.pc, next: b.next, target: b.target, n: b.ins.length, region, idx: j, name: `${R}_i${j}` });
	});
	lines.push(`static unsigned char ${R}_ok[${chosen.length}];`, `static struct kb_block* ${R}_blk[${chosen.length}];`, '');

	const body: string[] = [];
	let ipcNow = 0n;
	const spill = () => {
		body.push(`\tcpu->ipc = ${hex(ipcNow)};`);
		body.push(...regList.map((r) => `\tcpu->r[${r}] = g${r};`));
		body.push('\tcpu->n = f.n; cpu->z = f.z; cpu->c = f.c; cpu->v = f.v; cpu->p = f.p; cpu->df = df;');
	};
	const reload = () => {
		body.push(...regList.map((r) => `\tg${r} = cpu->r[${r}];`));
		body.push('\tf.n = cpu->n; f.z = cpu->z; f.c = cpu->c; f.v = cpu->v; f.p = cpu->p; df = cpu->df; gen = cpu->mapgen;');
	};
	// a block's exit: straight into the next lifted block when there is one and no signal waits
	const leave = (to: bigint) => {
		const k = index.get(to);
		if (k === undefined) return `{ pc = ${hex(to)}; goto out; }`;
		return `{ if (AOT_CONTINUE(${R}_ok[${k}])) goto B${k}; pc = ${hex(to)}; goto out; }`;
	};

	chosen.forEach((b, j) => {
		body.push(`B${j}: {`, `\tstruct kb_ic* ic = ${R}_blk[${j}]->ic;`, "\t(void) ic;");
		let ipc = b.pc;
		let m = 0;
		const fault = (why?: string, sig?: number) =>
			`{ ${why ? `cpu->fault = "${why}"; cpu->fault_sig = ${sig}; ` : ''}cpu->ipc = ${hex(ipc)}; pc = ${hex(b.pc)}; goto out; }`;
		b.ins.forEach((x, i) => {
			ipcNow = ipc;
			const [A, B, C, W] = [reg(x.a), reg(x.b), reg(x.c), x.w];
			const D = dst(x.a);
			const name = OPS[x.op]!.replace(/^KB_/, '');
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
				case 'UMULH': body.push(`\t${D} = (uint64_t) (((unsigned __int128) ${B} * ${C}) >> 64);`); break;
				case 'SMULH': body.push(`\t${D} = (uint64_t) (((__int128) (int64_t) ${B} * (int64_t) ${C}) >> 64);`); break;
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
					// the interpreter writes a faulting load's destination before it checks, and so does this
					body.push(
						`\t{ uint64_t va = ${B} + ${imm64(x.imm)}, v = 0; struct kb_ic* q = &ic[${m}];`,
						`\t  int slow = __builtin_expect(AOT_SLOW(q, gen, va, ${W}), 0);`,
						`\t  if (slow) v = kb_load_ic(cpu, q, va, ${W}); else memcpy(&v, q->host + (va - q->lo), ${W});`,
						`\t  ${D} = ${v};`,
						`\t  if (slow && cpu->fault) ${fault()} }`
					);
					m++;
					break;
				}
				case 'ST':
					body.push(
						`\t{ uint64_t va = ${B} + ${imm64(x.imm)}, v = ${A}; struct kb_ic* q = &ic[${m}];`,
						`\t  if (__builtin_expect(AOT_SLOW(q, gen, va, ${W}), 0)) { kb_store_ic(cpu, q, va, v, ${W}); if (cpu->fault) ${fault()} }`,
						`\t  else memcpy(q->host + (va - q->lo), &v, ${W}); }`
					);
					m++;
					break;
				case 'FLAGS': body.push(`\taot_flags(&f, ${x.imm}, ${B}, ${C}, ${A}, ${W});`); break;
				case 'SETCC': body.push(`\t${D} = (uint64_t) aot_cond(&f, ${x.imm});`); break;
				case 'SEL': body.push(`\t${D} = aot_cond(&f, ${x.imm}) ? ${B} : ${C};`); break;
				case 'BR': body.push(`\tif (aot_cond(&f, ${x.imm})) ${leave(b.target)}`); break;
				case 'BRZ': body.push(`\tif ((${A} != 0) == ${x.imm !== 0n ? 1 : 0}) ${leave(b.target)}`); break;
				case 'JMP': body.push(`\tpc = ${B}; goto dispatch;`); break;
				case 'PC': ipc = x.imm; break;
				case 'CARRY': body.push(`\t${D} = (uint64_t) f.c;`); break;
				case 'BSWAP': body.push(`\t${D} = __builtin_bswap64(${B}) >> ${64 - 8 * W};`); break;
				case 'CLZ':
					body.push(`\t{ uint64_t v = ${B} & aot_mask(${W}); ${D} = v ? (uint64_t) (__builtin_clzll(v) - ${64 - 8 * W}) : ${8 * W}u; }`);
					break;
				case 'CTZ': body.push(`\t{ uint64_t v = ${B} & aot_mask(${W}); ${D} = v ? (uint64_t) __builtin_ctzll(v) : ${8 * W}u; }`); break;
				case 'POPCNT': body.push(`\t${D} = (uint64_t) __builtin_popcountll(${B} & aot_mask(${W}));`); break;
				case 'FSBASE': body.push(`\t${D} = cpu->fs;`); break;
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
					spill();
					body.push(
						`\tif (${call}(cpu, &${R}_blk[${j}]->ins[${i}]) && !cpu->fault) { cpu->fault = "unknown ${name.toLowerCase()} instruction"; cpu->fault_sig = 4; }`,
						`\tif (cpu->fault) { cpu->ipc = ${hex(ipc)}; return ${hex(b.pc)}; }`
					);
					reload();
					break;
				}
				case 'X86STR':
					spill();
					body.push(`\tkb_aot_string(cpu, ${x.imm}, ${W}, ${x.c});`, `\tif (cpu->fault) { cpu->ipc = ${hex(ipc)}; return ${hex(b.pc)}; }`);
					reload();
					break;
				case 'SYSCALL':
					spill();
					body.push(
						`\tcpu->pc = ${hex(b.next)};`,
						'\tkb_syscall(cpu);',
						'\tif (cpu->exited) return 0;',
						'\tif (cpu->sigreturned) { cpu->sigreturned = 0; return cpu->pc; }',
						`\tif (cpu->fault) { cpu->ipc = ${hex(ipc)}; return ${hex(b.pc)}; }`
					);
					if (i === b.ins.length - 1) body.push(`\treturn ${hex(b.next)};`);
					else reload();
					break;
				default:
					throw new Error(`no lifting for ${name}`);
			}
		});
		const lastOp = OPS[b.ins.at(-1)!.op]!.replace(/^KB_/, '');
		if (lastOp !== 'JMP' && !(lastOp === 'SYSCALL')) body.push(`\t${leave(b.next)}`);
		body.push('}');
	});

	lines.push(`static uint64_t ${R}_run(struct kb_cpu* cpu, uint64_t pc) {`);
	lines.push(...regList.map((r) => `\tuint64_t g${r} = cpu->r[${r}];`));
	lines.push(
		'\tuint64_t sink = 0;',
		'\tstruct aot_fl f = {cpu->n, cpu->z, cpu->c, cpu->v, cpu->p};',
		'\tint df = cpu->df;',
		'\tuint32_t gen = cpu->mapgen;',
		'\t(void) sink;',
		'\tgoto dispatch;',
		'dispatch:',
		'\tif (*kb_pending_flag) goto out;',
		'\tswitch (pc) {'
	);
	chosen.forEach((b, j) => lines.push(`\t\tcase ${hex(b.pc)}: if (${R}_ok[${j}]) goto B${j}; goto out;`));
	lines.push('\t\tdefault: goto out;', '\t}');
	lines.push(...body);
	lines.push('out:');
	lines.push(...regList.map((r) => `\tcpu->r[${r}] = g${r};`));
	lines.push('\tcpu->n = f.n; cpu->z = f.z; cpu->c = f.c; cpu->v = f.v; cpu->p = f.p; cpu->df = df;', '\treturn pc;', '}', '');
});

table.sort((a, b) => (a.pc < b.pc ? -1 : a.pc > b.pc ? 1 : 0));
lines.push(
	'static const struct aot_entry aot_table[] = {',
	...table.map((e) => `\t{${hex(e.pc)}, ${hex(e.next)}, ${hex(e.target)}, ${e.n}, ${e.region}, ${e.idx}, ${e.name}},`),
	'};',
	`static unsigned char* const aot_ok[] = {${regionNames.map((n) => n.replace('_run', '_ok')).join(', ')}};`,
	`static struct kb_block** const aot_blk[] = {${regionNames.map((n) => n.replace('_run', '_blk')).join(', ')}};`,
	`static uint64_t (*const aot_run[])(struct kb_cpu*, uint64_t) = {${regionNames.join(', ')}};`,
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
	'\t\taot_ok[e->region][e->idx] = 1;',
	'\t\taot_blk[e->region][e->idx] = b;',
	'\t\tb->aot = aot_run[e->region];',
	'\t\treturn;',
	'\t}',
	'}'
);
writeFileSync(out, `${lines.join('\n')}\n`);
console.error(`wrote ${out}: ${table.length} blocks in ${regionNames.length} regions`);
