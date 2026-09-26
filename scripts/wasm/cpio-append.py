"""appends a newc cpio archive with extra files to an initramfs; the kernel unpacks archives in sequence.
Parent directories are added, because the kernel does not create them for a file"""
import sys
def entry(name, data, mode, ino):
    fields = [ino, mode, 0, 0, 1, 0, len(data), 0, 0, 0, 0, len(name) + 1, 0]
    head = b'070701' + b''.join(b'%08X' % f for f in fields)
    out = head + name.encode() + b'\0'
    out += b'\0' * (-len(out) % 4)
    out += data + b'\0' * (-len(data) % 4)
    return out
base, dst, *pairs = sys.argv[1:]
archive = b''
dirs = []
for pair in pairs:
    parts = pair.split('=')[0].strip('/').split('/')[:-1]
    for n in range(1, len(parts) + 1):
        if '/'.join(parts[:n]) not in dirs:
            dirs.append('/'.join(parts[:n]))
for i, d in enumerate(dirs):
    archive += entry(d, b'', 0o040755, 900 + i)
for i, pair in enumerate(pairs):
    path, src = pair.split('=')
    archive += entry(path.lstrip('/'), open(src, 'rb').read(), 0o100755, 1000 + i)
archive += entry('TRAILER!!!', b'', 0, 0)
data = open(base, 'rb').read()
data += b'\0' * (-len(data) % 4)
open(dst, 'wb').write(data + archive)
print(f'{dst}: {len(data) + len(archive)} bytes')
