"""Compares two outputs of x86-ops: per instruction form, how many cases differ, and the first one.
`python3 x86-ops-diff.py x86-ops.S native.bin katybug.bin`"""
import re, struct, sys
from collections import OrderedDict

labels = re.findall(r'^\t# (.*)$', open(sys.argv[1]).read(), re.M)
a, b = open(sys.argv[2], 'rb').read(), open(sys.argv[3], 'rb').read()
names = ['rax', 'rbx', 'rcx', 'rdx', 'flags', 'mem']
bad = OrderedDict()
for i, label in enumerate(labels):
    x, y = a[48 * i:48 * i + 48], b[48 * i:48 * i + 48]
    if x != y:
        form = label.split('#')[0]
        xs, ys = struct.unpack('<6Q', x.ljust(48, b'\0')), struct.unpack('<6Q', y.ljust(48, b'\0'))
        diff = [f'{n} {p:#x}/{q:#x}' for n, p, q in zip(names, xs, ys) if p != q]
        bad.setdefault(form, []).append(f'{label}: ' + ', '.join(diff))
for form, cases in bad.items():
    print(f'{form}: {len(cases)} differ; {cases[0]}')
print(f'{len(labels) - sum(len(v) for v in bad.values())}/{len(labels)} cases equal')
sys.exit(1 if bad else 0)
