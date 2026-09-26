import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Checks every store of a --generate-names wat against the kernel's page owner table (kernel patch
 * 0014): a u16 per 4 KiB page at gmux.table, the owning process's tag, 0xffff for a writable shared
 * page, 0xfffe for a read-only shared one. A store (atomic read-modify-writes included) to a page that
 * is neither the process's tag (gmux.tag) nor writable shared calls env.__gmux_denied, which faults.
 * A store that crosses a page is also checked at its last byte; memory.fill and memory.copy check
 * every page they write. Loads are not checked. The store keeps its own address and offset.
 * `guard-pass.ts in.wat out.wat [--inline]`
 */
const [src, dst, ...flags] = process.argv.slice(2);
const inline = flags.includes('--inline');
let text = readFileSync(src!, 'utf8');

// stored operand types above the address, top of stack last, and bytes written
const T = new Map<string, [string[], number]>();
for (const [w, n] of [
	['i32', 4],
	['i64', 8],
	['f32', 4],
	['f64', 8]
] as const)
	T.set(`${w}.store`, [[w], n]);
for (const w of ['i32', 'i64'])
	for (const [size, n] of [
		['8', 1],
		['16', 2],
		['32', 4]
	] as const) {
		if (w === 'i32' && size === '32') continue;
		T.set(`${w}.store${size}`, [[w], n]);
	}
T.set('v128.store', [['v128'], 16]);
for (const [w, full] of [
	['i32', 4],
	['i64', 8]
] as const)
	for (const [size, n] of [
		['', full],
		['8', 1],
		['16', 2],
		['32', 4]
	] as const) {
		if (w === 'i32' && size === '32') continue;
		T.set(`${w}.atomic.store${size}`, [[w], n]);
		const u = size === '' ? '' : '_u';
		for (const rmw of ['add', 'sub', 'and', 'or', 'xor', 'xchg'])
			T.set(`${w}.atomic.rmw${size}.${rmw}${u}`, [[w], n]);
		T.set(`${w}.atomic.rmw${size}.cmpxchg${u}`, [[w, w], n]);
	}

const CHECK = (a: string, t: string) => `    local.get ${a}
    i32.const 12
    i32.shr_u
    i32.const 1
    i32.shl
    global.get $gmux.table
    i32.add
    i32.load16_u
    local.tee ${t}
    global.get $gmux.tag
    i32.ne
    if
      local.get ${t}
      i32.const 65535
      i32.ne
      if
        local.get ${a}
        call $gmux.denied
      end
    end`;
const HELPERS =
	`  (func $gmux.check (param $a i32)
    (local $t i32)
` +
	CHECK('$a', '$t') +
	`)
  (func $gmux.range (param $d i32) (param $n i32)
    local.get $n
    i32.eqz
    if
      return
    end
    local.get $d
    local.get $n
    i32.add
    i32.const 1
    i32.sub
    local.set $n
    local.get $d
    i32.const -4096
    i32.and
    local.set $d
    block $done
      loop $next
        local.get $d
        call $gmux.check
        local.get $d
        i32.const 4096
        i32.add
        local.tee $d
        local.get $n
        i32.gt_u
        br_if $done
        br $next
      end
    end)`;
const STASH =
	'    (local $gmux.a i32) (local $gmux.b i32) (local $gmux.t i32) (local $gmux.i32 i32) (local $gmux.i32b i32) ' +
	'(local $gmux.i64 i64) (local $gmux.i64b i64) (local $gmux.f32 f32) (local $gmux.f64 f64) (local $gmux.v128 v128)';

const memoryImport = text.match(/ {2}\(import "env" "memory" \(memory[^\n]*\n/);
if (!memoryImport) throw new Error('no imported env.memory');
const afterMemory = memoryImport.index! + memoryImport[0].length;
text =
	text.slice(0, afterMemory) +
	'  (import "gmux" "table" (global $gmux.table i32))\n' +
	'  (import "gmux" "tag" (global $gmux.tag i32))\n' +
	text.slice(afterMemory);
const firstImport = text.indexOf('  (import ');
text =
	text.slice(0, firstImport) +
	'  (import "env" "__gmux_denied" (func $gmux.denied (param i32)))\n' +
	text.slice(firstImport);
const func = text.search(/\n {2}\(func /);
text = text.slice(0, func) + '\n' + HELPERS + text.slice(func);

const count = (s: string, c: string) => s.split(c).length - 1;
const balanced = (line: string) => count(line, '(') === count(line, ')');
const out: string[] = [];
let inFunc = false;
const counts = { stores: 0, atomics: 0, bulk: 0 };
for (const line of text.split('\n')) {
	const s = line.trimStart();
	if (line.startsWith('  (func $gmux.')) {
		inFunc = false;
		out.push(line);
		continue;
	}
	if (line.startsWith('  (func ')) {
		out.push(line);
		inFunc = !balanced(line);
		if (inFunc) out.push(STASH);
		continue;
	}
	if (!inFunc || !s || s.startsWith('(')) {
		out.push(line);
		continue;
	}
	const word = s.split(' ')[0]!.replace(/\)+$/, '');
	const ind = line.slice(0, line.length - s.length);
	const closing = s.length - s.replace(/\)+$/, '').length;
	const body = closing ? s.slice(0, s.length - closing) : s;
	const tail = ')'.repeat(closing);
	if (word === 'memory.fill' || word === 'memory.copy') {
		// (dest, value/source, n): check [dest, dest + n) and leave the operands as they were
		const second = '$gmux.i32b';
		out.push(
			`${ind}local.set $gmux.i32`,
			`${ind}local.set ${second}`,
			`${ind}local.tee $gmux.a`,
			`${ind}local.get $gmux.i32`,
			`${ind}call $gmux.range`,
			`${ind}local.get $gmux.a`,
			`${ind}local.get ${second}`,
			`${ind}local.get $gmux.i32`,
			`${ind}${body}${tail}`
		);
		counts.bulk++;
		continue;
	}
	const entry = T.get(word);
	if (!entry) {
		out.push(line);
		continue;
	}
	const [stash, size] = entry;
	let offset = 0;
	for (const p of body.trim().split(/\s+/).slice(1))
		if (p.startsWith('offset=')) offset = Number(p.slice(7));
	const names: string[] = [];
	const used = new Map<string, number>();
	for (const ty of [...stash].reverse()) {
		const n = used.get(ty) ?? 0;
		used.set(ty, n + 1);
		const name = `$gmux.${ty}` + (n ? 'b' : '');
		names.push(name);
		out.push(`${ind}local.set ${name}`);
	}
	out.push(`${ind}local.tee $gmux.b`);
	if (offset) out.push(`${ind}i32.const ${offset}`, `${ind}i32.add`);
	if (inline) {
		out.push(`${ind}local.set $gmux.a`);
		out.push(
			...CHECK('$gmux.a', '$gmux.t')
				.split('\n')
				.map((l) => ind + l.trim())
		);
	} else out.push(`${ind}local.tee $gmux.a`, `${ind}call $gmux.check`);
	if (size > 1)
		// the last byte's page, when it is another page
		out.push(
			`${ind}local.get $gmux.a`,
			`${ind}i32.const 4095`,
			`${ind}i32.and`,
			`${ind}i32.const ${4096 - size}`,
			`${ind}i32.gt_u`,
			`${ind}if`,
			`${ind}  local.get $gmux.a`,
			`${ind}  i32.const ${size - 1}`,
			`${ind}  i32.add`,
			`${ind}  call $gmux.check`,
			`${ind}end`
		);
	out.push(`${ind}local.get $gmux.b`);
	for (const name of [...names].reverse()) out.push(`${ind}local.get ${name}`);
	out.push(`${ind}${body}${tail}`);
	counts[word.includes('atomic') ? 'atomics' : 'stores']++;
}
writeFileSync(dst!, out.join('\n'));
console.log(
	`guard: {'stores': ${counts.stores}, 'atomics': ${counts.atomics}, 'bulk': ${counts.bulk}}`
);
