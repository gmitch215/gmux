"""appends a gmux.memory custom section holding the imported memory's initial page count, which the
host needs before instantiating and can read from a compiled Module (customSections)"""
import struct
import sys


def leb(data, i):
    result = shift = 0
    while True:
        byte = data[i]
        i += 1
        result |= (byte & 0x7F) << shift
        shift += 7
        if byte < 0x80:
            return result, i


def initial_pages(data):
    i = 8
    while i < len(data):
        sid = data[i]
        size, i = leb(data, i + 1)
        if sid == 2:
            count, j = leb(data, i)
            for _ in range(count):
                n, j = leb(data, j)
                j += n
                n, j = leb(data, j)
                j += n
                kind = data[j]
                j += 1
                if kind == 2:
                    flags, j = leb(data, j)
                    initial, j = leb(data, j)
                    return initial
                if kind == 0:
                    _, j = leb(data, j)
                elif kind == 1:
                    j += 1
                    flags, j = leb(data, j)
                    _, j = leb(data, j)
                    if flags & 1:
                        _, j = leb(data, j)
                elif kind == 3:
                    j += 2
                elif kind == 4:
                    j += 1
                    _, j = leb(data, j)
        i += size
    sys.exit('no imported memory')


def section(name, payload):
    body = bytes([len(name)]) + name + payload
    out, n = bytearray(), len(body)
    while True:
        byte = n & 0x7F
        n >>= 7
        out.append(byte | (0x80 if n else 0))
        if not n:
            break
    return b'\x00' + bytes(out) + body


path = sys.argv[1]
data = open(path, 'rb').read()
pages = initial_pages(data)
open(path, 'wb').write(data + section(b'gmux.memory', struct.pack('<I', pages)))
print(f'{path}: gmux.memory = {pages} pages')
