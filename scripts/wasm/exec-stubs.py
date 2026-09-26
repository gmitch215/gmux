"""rewrites an initramfs so each wasm executable is a stub: its header, its dylink.0 section (all
binfmt_wasm reads) and a gmux.exec section holding the SHA-256 of the full file, the registry key.
The host already holds the compiled module, so a machine no longer keeps the code in its RAM"""
import gzip, hashlib, sys

MAGIC = b'\0asm\x01\0\0\0'


def leb(n):
    out = b''
    while True:
        b = n & 0x7F
        n >>= 7
        out += bytes([b | (0x80 if n else 0)])
        if not n:
            return out


def read_leb(data, p):
    n = shift = 0
    while True:
        b = data[p]
        p += 1
        n |= (b & 0x7F) << shift
        shift += 7
        if b < 0x80:
            return n, p


def stub(data):
    if not data.startswith(MAGIC) or len(data) < 10 or data[8] != 0:
        return None
    size, body = read_leb(data, 9)
    name_len, name = read_leb(data, body)
    if data[name:name + name_len] != b'dylink.0':
        return None
    payload = b'\x09gmux.exec' + hashlib.sha256(data).digest()
    return MAGIC + data[8:body + size] + b'\0' + leb(len(payload)) + payload


src, dst = sys.argv[1:]
data = gzip.decompress(open(src, 'rb').read())
out, p, stubbed = b'', 0, []
# the kernel unpacks archives one after another, NUL padding between them
while data[p:p + 6] == b'070701':
    head = data[p:p + 110]
    fields = [int(head[6 + 8 * i:14 + 8 * i], 16) for i in range(13)]
    mode, size, name_len = fields[1], fields[6], fields[11]
    name_at = p + 110
    name = data[name_at:name_at + name_len - 1].decode()
    body_at = name_at + name_len + (-(110 + name_len) % 4)
    body = data[body_at:body_at + size]
    p = body_at + size + (-size % 4)
    small = stub(body) if mode & 0o170000 == 0o100000 else None
    if small is not None:
        stubbed.append(f'{name} {size} -> {len(small)}')
        body, fields[6] = small, len(small)
    entry = b'070701' + b''.join(b'%08X' % f for f in fields) + name.encode() + b'\0'
    entry += b'\0' * (-len(entry) % 4)
    out += entry + body + b'\0' * (-len(body) % 4)
    if name == 'TRAILER!!!':
        while data[p:p + 1] == b'\0':
            p += 1
open(dst, 'wb').write(gzip.compress(out, mtime=0))
print('\n'.join(stubbed))
