"""routes every memory access of a --generate-names wat through a software MMU: $gmux.tr looks the
address's page up in a flat page table in its own memory (gmux.tlb, 4 bytes a page: the delta to add,
with bit 0 set when valid) and asks the host (env.__gmux_mmu_miss) when it is not. Offsets
fold into the address first. memory.fill and memory.copy become per-page loops; memory.init (data
segments at instantiation) is left alone. An access that crosses a page takes its first byte's page.
A miss is synchronous (a start function runs outside WebAssembly.promising); when the page has to be
brought in, it returns -1 and env.__gmux_mmu_fault, a suspending import, parks the task until it is.
usage: mmu-pass.py in.wat out.wat [--inline]"""
import re, sys

src, dst = sys.argv[1], sys.argv[2]
inline = '--inline' in sys.argv[3:]

text = open(src).read()

# operand types above the address, top of stack last, per instruction
T = {}
for op in ['i32.load', 'i32.load8_s', 'i32.load8_u', 'i32.load16_s', 'i32.load16_u', 'i64.load', 'i64.load8_s',
           'i64.load8_u', 'i64.load16_s', 'i64.load16_u', 'i64.load32_s', 'i64.load32_u', 'f32.load', 'f64.load',
           'v128.load', 'v128.load8x8_s', 'v128.load8x8_u', 'v128.load16x4_s', 'v128.load16x4_u', 'v128.load32x2_s',
           'v128.load32x2_u', 'v128.load8_splat', 'v128.load16_splat', 'v128.load32_splat', 'v128.load64_splat',
           'v128.load32_zero', 'v128.load64_zero', 'i32.atomic.load', 'i32.atomic.load8_u', 'i32.atomic.load16_u',
           'i64.atomic.load', 'i64.atomic.load8_u', 'i64.atomic.load16_u', 'i64.atomic.load32_u']:
    T[op] = []
for w in ['i32', 'i64', 'f32', 'f64']:
    for suffix in ['', '8', '16', '32']:
        T[f'{w}.store{suffix}'] = [w]
T['v128.store'] = ['v128']
for w in ['i32', 'i64']:
    for size in ['', '8', '16', '32']:
        T[f'{w}.atomic.store{size}'] = [w]
        for rmw in ['add', 'sub', 'and', 'or', 'xor', 'xchg']:
            T[f'{w}.atomic.rmw{size}.{rmw}' + ('' if size == '' else '_u')] = [w]
        T[f'{w}.atomic.rmw{size}.cmpxchg' + ('' if size == '' else '_u')] = [w, w]
T['memory.atomic.wait32'] = ['i32', 'i64']
T['memory.atomic.wait64'] = ['i64', 'i64']
T['memory.atomic.notify'] = ['i32']

TR = '''  (func $gmux.tr (param $a i32) (result i32)
    (local $e i32)
{fast}
  )'''
FAST = '''    local.get {a}
    i32.const 12
    i32.shr_u
    i32.const 2
    i32.shl
    i32.load $gmux.tlb
    local.tee {e}
    i32.const 1
    i32.and
    if (result i32)
      local.get {a}
      local.get {e}
      i32.const -2
      i32.and
      i32.add
    else
      local.get {a}
      call $gmux.miss
      local.tee {e}
      i32.const -1
      i32.eq
      if (result i32)
        local.get {a}
        call $gmux.fault
      else
        local.get {e}
      end
    end'''
HELPERS = '''  (func $gmux.fill (param $d i32) (param $v i32) (param $n i32)
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
    end)'''

STASH = '    (local $gmux.a i32) (local $gmux.e i32) (local $gmux.i32 i32) (local $gmux.i32b i32) ' \
        '(local $gmux.i64 i64) (local $gmux.i64b i64) (local $gmux.f32 f32) (local $gmux.f64 f64) (local $gmux.v128 v128)'

first_import = text.index('  (import ')
memory_import = re.search(r'  \(import "env" "memory" \(memory[^\n]*\n', text)
if not memory_import:
    sys.exit('no imported env.memory')
text = (text[:memory_import.end()] + '  (import "gmux" "tlb" (memory $gmux.tlb 1))\n' + text[memory_import.end():])
text = (text[:first_import] + '  (import "env" "__gmux_mmu_miss" (func $gmux.miss (param i32) (result i32)))\n'
        + '  (import "env" "__gmux_mmu_fault" (func $gmux.fault (param i32) (result i32)))\n' + text[first_import:])
m = re.search(r'\n  \(func ', text)
text = text[:m.start()] + '\n' + TR.format(fast=FAST.format(a='$a', e='$e')) + '\n' + HELPERS + text[m.start():]


def balanced(line):
    return line.count('(') == line.count(')')


out = []
in_func = False
counts = {'loads': 0, 'stores': 0, 'atomics': 0, 'bulk': 0}
for line in text.split('\n'):
    s = line.lstrip()
    if line.startswith('  (func $gmux.'):
        in_func = False
        out.append(line)
        continue
    if line.startswith('  (func '):
        out.append(line)
        in_func = not balanced(line)
        if in_func:
            out.append(STASH)
        continue
    if not in_func or not s or s.startswith('('):
        out.append(line)
        continue
    word = s.split(' ', 1)[0].rstrip(')')
    ind = line[: len(line) - len(s)]
    closing = len(s) - len(s.rstrip(')'))
    body = s[: len(s) - closing] if closing else s
    tail = ')' * closing
    if word in ('memory.fill', 'memory.copy'):
        out.append(f'{ind}call $gmux.{word.split(".")[1]}{tail}')
        counts['bulk'] += 1
        continue
    if word not in T:
        out.append(line)
        continue
    parts = body.split()
    offset = 0
    rest = []
    for p in parts[1:]:
        if p.startswith('offset='):
            offset = int(p[7:], 0)
        else:
            rest.append(p)
    stash = T[word]
    names = []
    used = {}
    for ty in reversed(stash):
        n = used.get(ty, 0)
        used[ty] = n + 1
        name = f'$gmux.{ty}' + ('b' if n else '')
        names.append(name)
        out.append(f'{ind}local.set {name}')
    if offset:
        out.append(f'{ind}i32.const {offset}')
        out.append(f'{ind}i32.add')
    if inline:
        out.append(f'{ind}local.set $gmux.a')
        out.extend(ind + l.strip() for l in FAST.format(a='$gmux.a', e='$gmux.e').split('\n'))
    else:
        out.append(f'{ind}call $gmux.tr')
    for name in reversed(names):
        out.append(f'{ind}local.get {name}')
    out.append(f'{ind}{" ".join([word] + rest)}{tail}')
    counts['atomics' if 'atomic' in word else 'stores' if stash else 'loads'] += 1
open(dst, 'w').write('\n'.join(out))
print(f'mmu: {counts}')
