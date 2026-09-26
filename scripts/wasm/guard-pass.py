"""checks every store of a --generate-names wat against the kernel's page owner table (kernel
patch 0014): a u16 per 4 KiB page at gmux.table, the owning process's tag, 0xffff for a writable
shared page, 0xfffe for a read-only shared one. A store (atomic read-modify-writes included) to a
page that is neither the process's tag (gmux.tag) nor writable shared calls env.__gmux_denied, which
faults. A store that crosses a page is also checked at its last byte; memory.fill and memory.copy
check every page they write. Loads are not checked. The store keeps its own address and offset.
usage: guard-pass.py in.wat out.wat [--inline]"""
import re, sys

src, dst = sys.argv[1], sys.argv[2]
inline = '--inline' in sys.argv[3:]
text = open(src).read()

# stored operand types above the address, top of stack last, and bytes written
T = {}
for w, n in [('i32', 4), ('i64', 8), ('f32', 4), ('f64', 8)]:
    T[f'{w}.store'] = ([w], n)
for w in ['i32', 'i64']:
    for size, n in [('8', 1), ('16', 2), ('32', 4)]:
        if w == 'i32' and size == '32':
            continue
        T[f'{w}.store{size}'] = ([w], n)
T['v128.store'] = (['v128'], 16)
for w, full in [('i32', 4), ('i64', 8)]:
    for size, n in [('', full), ('8', 1), ('16', 2), ('32', 4)]:
        if w == 'i32' and size == '32':
            continue
        T[f'{w}.atomic.store{size}'] = ([w], n)
        for rmw in ['add', 'sub', 'and', 'or', 'xor', 'xchg']:
            T[f'{w}.atomic.rmw{size}.{rmw}' + ('' if size == '' else '_u')] = ([w], n)
        T[f'{w}.atomic.rmw{size}.cmpxchg' + ('' if size == '' else '_u')] = ([w, w], n)

CHECK = '''    local.get {a}
    i32.const 12
    i32.shr_u
    i32.const 1
    i32.shl
    global.get $gmux.table
    i32.add
    i32.load16_u
    local.tee {t}
    global.get $gmux.tag
    i32.ne
    if
      local.get {t}
      i32.const 65535
      i32.ne
      if
        local.get {a}
        call $gmux.denied
      end
    end'''
HELPERS = '''  (func $gmux.check (param $a i32)
    (local $t i32)
''' + CHECK.format(a='$a', t='$t') + ''')
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
    end)'''

STASH = '    (local $gmux.a i32) (local $gmux.b i32) (local $gmux.t i32) (local $gmux.i32 i32) (local $gmux.i32b i32) ' \
        '(local $gmux.i64 i64) (local $gmux.i64b i64) (local $gmux.f32 f32) (local $gmux.f64 f64) (local $gmux.v128 v128)'

memory_import = re.search(r'  \(import "env" "memory" \(memory[^\n]*\n', text)
if not memory_import:
    sys.exit('no imported env.memory')
text = (text[:memory_import.end()] + '  (import "gmux" "table" (global $gmux.table i32))\n'
        + '  (import "gmux" "tag" (global $gmux.tag i32))\n' + text[memory_import.end():])
first_import = text.index('  (import ')
text = text[:first_import] + '  (import "env" "__gmux_denied" (func $gmux.denied (param i32)))\n' + text[first_import:]
m = re.search(r'\n  \(func ', text)
text = text[:m.start()] + '\n' + HELPERS + text[m.start():]


def balanced(line):
    return line.count('(') == line.count(')')


out = []
in_func = False
counts = {'stores': 0, 'atomics': 0, 'bulk': 0}
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
        # (dest, value/source, n): check [dest, dest + n) and leave the operands as they were
        second = '$gmux.i32b'
        out += [f'{ind}local.set $gmux.i32', f'{ind}local.set {second}', f'{ind}local.tee $gmux.a',
                f'{ind}local.get $gmux.i32', f'{ind}call $gmux.range', f'{ind}local.get $gmux.a',
                f'{ind}local.get {second}', f'{ind}local.get $gmux.i32', f'{ind}{body}{tail}']
        counts['bulk'] += 1
        continue
    if word not in T:
        out.append(line)
        continue
    stash, size = T[word]
    offset = 0
    for p in body.split()[1:]:
        if p.startswith('offset='):
            offset = int(p[7:], 0)
    names = []
    used = {}
    for ty in reversed(stash):
        n = used.get(ty, 0)
        used[ty] = n + 1
        name = f'$gmux.{ty}' + ('b' if n else '')
        names.append(name)
        out.append(f'{ind}local.set {name}')
    out.append(f'{ind}local.tee $gmux.b')
    if offset:
        out += [f'{ind}i32.const {offset}', f'{ind}i32.add']
    if inline:
        out.append(f'{ind}local.set $gmux.a')
        out.extend(ind + l.strip() for l in CHECK.format(a='$gmux.a', t='$gmux.t').split('\n'))
    else:
        out += [f'{ind}local.tee $gmux.a', f'{ind}call $gmux.check']
    if size > 1:
        # the last byte's page, when it is another page
        out += [f'{ind}local.get $gmux.a', f'{ind}i32.const 4095', f'{ind}i32.and', f'{ind}i32.const {4096 - size}',
                f'{ind}i32.gt_u', f'{ind}if', f'{ind}  local.get $gmux.a', f'{ind}  i32.const {size - 1}',
                f'{ind}  i32.add', f'{ind}  call $gmux.check', f'{ind}end']
    out.append(f'{ind}local.get $gmux.b')
    for name in reversed(names):
        out.append(f'{ind}local.get {name}')
    out.append(f'{ind}{body}{tail}')
    counts['atomics' if 'atomic' in word else 'stores'] += 1
open(dst, 'w').write('\n'.join(out))
print(f'guard: {counts}')
