import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Routes every memory access of a --generate-names wat through a software MMU: $gmux.tr looks the
 * address's page up in a flat page table in its own memory (gmux.tlb, 4 bytes a page: the delta to
 * add, with bit 0 set when valid) and asks the host (env.__gmux_mmu_miss) when it is not. Offsets fold
 * into the address first. memory.fill and memory.copy become per-page loops; memory.init (data
 * segments at instantiation) is left alone. An access that crosses a page takes its first byte's page.
 * A miss is synchronous (a start function runs outside WebAssembly.promising); when the page has to be
 * brought in, it returns -1 and env.__gmux_mmu_fault, a suspending import, parks the task until it is.
 * `mmu-pass.ts in.wat out.wat [--inline]`
 */
const [src, dst, ...flags] = process.argv.slice(2);
const inline = flags.includes('--inline');
let text = readFileSync(src!, 'utf8');

// operand types above the address, top of stack last, per instruction
const T = new Map<string, string[]>();
for (const op of [
	'i32.load',
	'i32.load8_s',
	'i32.load8_u',
	'i32.load16_s',
	'i32.load16_u',
	'i64.load',
	'i64.load8_s',
	'i64.load8_u',
	'i64.load16_s',
	'i64.load16_u',
	'i64.load32_s',
	'i64.load32_u',
	'f32.load',
	'f64.load',
	'v128.load',
	'v128.load8x8_s',
	'v128.load8x8_u',
	'v128.load16x4_s',
	'v128.load16x4_u',
	'v128.load32x2_s',
	'v128.load32x2_u',
	'v128.load8_splat',
	'v128.load16_splat',
	'v128.load32_splat',
	'v128.load64_splat',
	'v128.load32_zero',
	'v128.load64_zero',
	'i32.atomic.load',
	'i32.atomic.load8_u',
	'i32.atomic.load16_u',
	'i64.atomic.load',
	'i64.atomic.load8_u',
	'i64.atomic.load16_u',
	'i64.atomic.load32_u'
])
	T.set(op, []);
for (const w of ['i32', 'i64', 'f32', 'f64'])
	for (const suffix of ['', '8', '16', '32']) T.set(`${w}.store${suffix}`, [w]);
T.set('v128.store', ['v128']);
for (const w of ['i32', 'i64'])
	for (const size of ['', '8', '16', '32']) {
		const u = size === '' ? '' : '_u';
		T.set(`${w}.atomic.store${size}`, [w]);
		for (const rmw of ['add', 'sub', 'and', 'or', 'xor', 'xchg'])
			T.set(`${w}.atomic.rmw${size}.${rmw}${u}`, [w]);
		T.set(`${w}.atomic.rmw${size}.cmpxchg${u}`, [w, w]);
	}
T.set('memory.atomic.wait32', ['i32', 'i64']);
T.set('memory.atomic.wait64', ['i64', 'i64']);
T.set('memory.atomic.notify', ['i32']);

const FAST = (a: string, e: string) => `    local.get ${a}
    i32.const 12
    i32.shr_u
    i32.const 2
    i32.shl
    i32.load $gmux.tlb
    local.tee ${e}
    i32.const 1
    i32.and
    if (result i32)
      local.get ${a}
      local.get ${e}
      i32.const -2
      i32.and
      i32.add
    else
      local.get ${a}
      call $gmux.miss
      local.tee ${e}
      i32.const -1
      i32.eq
      if (result i32)
        local.get ${a}
        call $gmux.fault
      else
        local.get ${e}
      end
    end`;
const TR = (fast: string) => `  (func $gmux.tr (param $a i32) (result i32)
    (local $e i32)
${fast}
  )`;
const HELPERS = `  (func $gmux.fill (param $d i32) (param $v i32) (param $n i32)
    (local $c i32)
    block $done
      loop $next
        local.get $n
        i32.eqz
        br_if $done
        i32.const 4096
        local.get $d
        i32.const 4095
        i32.and
        i32.sub
        local.tee $c
        local.get $n
        local.get $c
        local.get $n
        i32.lt_u
        select
        local.set $c
        local.get $d
        call $gmux.tr
        local.get $v
        local.get $c
        memory.fill
        local.get $d
        local.get $c
        i32.add
        local.set $d
        local.get $n
        local.get $c
        i32.sub
        local.set $n
        br $next
      end
    end)
  (func $gmux.chunk (param $a i32) (param $b i32) (param $n i32) (result i32)
    (local $c i32)
    i32.const 4096
    local.get $a
    i32.const 4095
    i32.and
    i32.sub
    local.tee $c
    i32.const 4096
    local.get $b
    i32.const 4095
    i32.and
    i32.sub
    local.tee $a
    local.get $c
    local.get $a
    i32.lt_u
    select
    local.tee $c
    local.get $n
    local.get $c
    local.get $n
    i32.lt_u
    select)
  (func $gmux.copy (param $d i32) (param $s i32) (param $n i32)
    (local $c i32) (local $x i32) (local $y i32)
    ;; overlapping with the destination above the source: copy from the end, as memmove does
    local.get $d
    local.get $s
    i32.gt_u
    local.get $d
    local.get $s
    local.get $n
    i32.add
    i32.lt_u
    i32.and
    if
      local.get $d
      local.get $n
      i32.add
      local.set $x
      local.get $s
      local.get $n
      i32.add
      local.set $y
      block $done
        loop $next
          local.get $n
          i32.eqz
          br_if $done
          local.get $x
          i32.const 1
          i32.sub
          i32.const 4095
          i32.and
          i32.const 1
          i32.add
          local.tee $c
          local.get $y
          i32.const 1
          i32.sub
          i32.const 4095
          i32.and
          i32.const 1
          i32.add
          local.tee $d
          local.get $c
          local.get $d
          i32.lt_u
          select
          local.tee $c
          local.get $n
          local.get $c
          local.get $n
          i32.lt_u
          select
          local.set $c
          local.get $x
          local.get $c
          i32.sub
          local.tee $x
          call $gmux.tr
          local.get $y
          local.get $c
          i32.sub
          local.tee $y
          call $gmux.tr
          local.get $c
          memory.copy
          local.get $n
          local.get $c
          i32.sub
          local.set $n
          br $next
        end
      end
      return
    end
    block $done
      loop $next
        local.get $n
        i32.eqz
        br_if $done
        local.get $d
        local.get $s
        local.get $n
        call $gmux.chunk
        local.set $c
        local.get $d
        call $gmux.tr
        local.get $s
        call $gmux.tr
        local.get $c
        memory.copy
        local.get $d
        local.get $c
        i32.add
        local.set $d
        local.get $s
        local.get $c
        i32.add
        local.set $s
        local.get $n
        local.get $c
        i32.sub
        local.set $n
        br $next
      end
    end)`;
const STASH =
	'    (local $gmux.a i32) (local $gmux.e i32) (local $gmux.i32 i32) (local $gmux.i32b i32) ' +
	'(local $gmux.i64 i64) (local $gmux.i64b i64) (local $gmux.f32 f32) (local $gmux.f64 f64) (local $gmux.v128 v128)';

const firstImport = text.indexOf('  (import ');
const memoryImport = text.match(/ {2}\(import "env" "memory" \(memory[^\n]*\n/);
if (!memoryImport) throw new Error('no imported env.memory');
const afterMemory = memoryImport.index! + memoryImport[0].length;
text =
	text.slice(0, afterMemory) +
	'  (import "gmux" "tlb" (memory $gmux.tlb 1))\n' +
	text.slice(afterMemory);
text =
	text.slice(0, firstImport) +
	'  (import "env" "__gmux_mmu_miss" (func $gmux.miss (param i32) (result i32)))\n' +
	'  (import "env" "__gmux_mmu_fault" (func $gmux.fault (param i32) (result i32)))\n' +
	text.slice(firstImport);
const func = text.search(/\n {2}\(func /);
text = text.slice(0, func) + '\n' + TR(FAST('$a', '$e')) + '\n' + HELPERS + text.slice(func);

const count = (s: string, c: string) => s.split(c).length - 1;
const balanced = (line: string) => count(line, '(') === count(line, ')');
const out: string[] = [];
let inFunc = false;
const counts = { loads: 0, stores: 0, atomics: 0, bulk: 0 };
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
		out.push(`${ind}call $gmux.${word.split('.')[1]}${tail}`);
		counts.bulk++;
		continue;
	}
	const stash = T.get(word);
	if (!stash) {
		out.push(line);
		continue;
	}
	let offset = 0;
	const rest: string[] = [];
	for (const p of body.trim().split(/\s+/).slice(1)) {
		if (p.startsWith('offset=')) offset = Number(p.slice(7));
		else rest.push(p);
	}
	const names: string[] = [];
	const used = new Map<string, number>();
	for (const ty of [...stash].reverse()) {
		const n = used.get(ty) ?? 0;
		used.set(ty, n + 1);
		const name = `$gmux.${ty}` + (n ? 'b' : '');
		names.push(name);
		out.push(`${ind}local.set ${name}`);
	}
	if (offset) out.push(`${ind}i32.const ${offset}`, `${ind}i32.add`);
	if (inline) {
		out.push(`${ind}local.set $gmux.a`);
		out.push(
			...FAST('$gmux.a', '$gmux.e')
				.split('\n')
				.map((l) => ind + l.trim())
		);
	} else out.push(`${ind}call $gmux.tr`);
	for (const name of [...names].reverse()) out.push(`${ind}local.get ${name}`);
	out.push(`${ind}${[word, ...rest].join(' ')}${tail}`);
	counts[word.includes('atomic') ? 'atomics' : stash.length ? 'stores' : 'loads']++;
}
writeFileSync(dst!, out.join('\n'));
console.log(
	`mmu: {'loads': ${counts.loads}, 'stores': ${counts.stores}, 'atomics': ${counts.atomics}, 'bulk': ${counts.bulk}}`
);
