"""prototype fuel pass over a --generate-names wat: count down at every loop head, yield at zero"""
import re, sys
src, dst = sys.argv[1], sys.argv[2]
text = open(src).read()
# the import goes first, so it takes no index; everything is referenced by name
first_import = text.index('  (import ')
text = text[:first_import] + '  (import "env" "__gmux_fuel" (func $gmux.fuel (result i32)))\n' + text[first_import:]
# one mutable global, defined after the last global or before the first func
m = re.search(r'\n  \(func ', text)
text = text[:m.start()] + '\n  (global $gmux.budget (mut i32) (i32.const 100000))' + text[m.start():]
check = (
    '{ind}global.get $gmux.budget\n{ind}i32.const 1\n{ind}i32.sub\n{ind}global.set $gmux.budget\n'
    '{ind}global.get $gmux.budget\n{ind}i32.const 0\n{ind}i32.lt_s\n{ind}if\n'
    '{ind}  call $gmux.fuel\n{ind}  global.set $gmux.budget\n{ind}end\n'
)
lines = text.split('\n')
out = []
loops = 0
for line in lines:
    out.append(line)
    s = line.lstrip()
    if s.startswith('loop') and (len(s) == 4 or s[4] in ' ;'):
        ind = line[: len(line) - len(s)] + '  '
        out.append(check.format(ind=ind).rstrip('\n'))
        loops += 1
open(dst, 'w').write('\n'.join(out))
print(f'instrumented {loops} loops')
