"""keep only the vmlinux exports the gmux host uses; each export costs JS heap in every task instance"""
import re, sys
src, dst = sys.argv[1], sys.argv[2]
keep = set(sys.argv[3].split(','))
text = open(src).read()
removed = kept = 0
out = []
for line in text.split('\n'):
    m = re.match(r'\s*\(export "([^"]+)"', line)
    if m:
        if m.group(1) in keep:
            kept += 1
            out.append(line)
        else:
            removed += 1
        continue
    out.append(line)
open(dst, 'w').write('\n'.join(out))
print(f'kept {kept} exports, removed {removed}')
