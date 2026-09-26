"""split stacks for a --generate-names wat: each new stack pointer a frame allocation computes (an
i32.sub whose result reaches global.set $__stack_pointer) is checked against the segment limits the
host sets through __gmux_set_stack_limits(high, low). Outside them, env.__gmux_stack_move gets it and
returns the stack pointer to use: the same one after a return into an older segment, or one at the
top of a new segment when the frame does not fit, which is how a stack grows without an MMU. Frames
never move: each function's epilogue rebuilds its caller's stack pointer from its own frame. Writes
that restore a saved value are not checked. musl's __wasm_crtjmp, which moves to another stack on
purpose, is left alone. The limits start wide open, so code that runs before the host sets them is
not stopped. The host puts the lower limit a guard of GUARD bytes above the segment's real bottom, so a
function that calls nothing and allocates at most GUARD needs no check: its caller's check left room."""
import re, sys

src, dst = sys.argv[1], sys.argv[2]
text = open(src).read()
first_import = text.index('  (import ')
text = (text[:first_import] + '  (import "env" "__gmux_stack_move" (func $gmux.stack_move (param i32) (result i32)))\n'
        + text[first_import:])
m = re.search(r'\n  \(func ', text)
text = text[:m.start()] + '''
  (global $gmux.stack_low (mut i32) (i32.const 0))
  (global $gmux.stack_size (mut i32) (i32.const -1))
  (func $gmux.set_stack_limits (export "__gmux_set_stack_limits") (param $high i32) (param $low i32)
    local.get $low
    global.set $gmux.stack_low
    local.get $high
    local.get $low
    i32.sub
    global.set $gmux.stack_size)''' + text[m.start():]
# one unsigned comparison covers both ends: sp - low wraps above the size when sp is below low
check = (
    '{ind}local.tee $gmux.sp\n{ind}global.get $gmux.stack_low\n{ind}i32.sub\n'
    '{ind}global.get $gmux.stack_size\n{ind}i32.gt_u\n'
    '{ind}if (result i32)\n{ind}  local.get $gmux.sp\n{ind}  call $gmux.stack_move\n'
    '{ind}else\n{ind}  local.get $gmux.sp\n{ind}end'
)
SWITCHERS = ('$__wasm_crtjmp',)
GUARD = 4096
lines = text.split('\n')
# functions that call nothing, by the line their header is on
leaf = {}
header = None
for n, line in enumerate(lines):
    if line.startswith('  (func '):
        header = n
        leaf[n] = True
    elif header is not None and line.lstrip().startswith(('call ', 'call_indirect', 'return_call')):
        leaf[header] = False
header = None
out = []
checks = 0
switcher = False
for n, line in enumerate(lines):
    s = line.lstrip()
    if line.startswith('  (func '):
        header = n
        name = line.split()[1] if len(line.split()) > 1 else ''
        switcher = line.startswith('  (func $gmux.') or name in SWITCHERS
        out.append(line)
        if not switcher and line.count('(') != line.count(')'):
            out.append('    (local $gmux.sp i32)')
        continue
    out.append(line)
    # a subtraction whose result goes, through at most one local.tee, into the stack pointer
    if switcher or not s.startswith('i32.sub'):
        continue
    ahead = [l.lstrip() for l in lines[n + 1:n + 3]]
    small = re.match(r'i32\.const (\d+)$', lines[n - 1].lstrip())
    if leaf.get(header) and small and int(small.group(1)) <= GUARD:
        continue
    if (ahead and ahead[0].startswith('global.set $__stack_pointer')) or (
            len(ahead) == 2 and ahead[0].startswith('local.tee ') and ahead[1].startswith('global.set $__stack_pointer')):
        out.append(check.format(ind=line[: len(line) - len(s)]))
        checks += 1
open(dst, 'w').write('\n'.join(out))
print(f'checked {checks} frame allocations')
