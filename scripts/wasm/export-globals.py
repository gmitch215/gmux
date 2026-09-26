"""appends global exports: export-globals.py in.wasm out.wasm (name=index ... | --all-mutable)"""
import sys

def leb(b, i):
	r = s = 0
	while True:
		x = b[i]; i += 1
		r |= (x & 0x7f) << s; s += 7
		if x < 0x80: return r, i

def uleb(n):
	out = bytearray()
	while True:
		x = n & 0x7f; n >>= 7
		out.append(x | (0x80 if n else 0))
		if not n: return bytes(out)

def sections(b):
	i = 8
	while i < len(b):
		sid = b[i]; size, j = leb(b, i + 1)
		yield sid, i, j, j + size
		i = j + size

def mutable_globals(b):
	"""indices of mutable globals, imported globals counted first as the index space requires"""
	imported = 0
	found = []
	for sid, _, j, end in sections(b):
		if sid == 2:
			count, k = leb(b, j)
			for _ in range(count):
				n, k = leb(b, k); k += n
				n, k = leb(b, k); k += n
				kind = b[k]; k += 1
				if kind == 0: _, k = leb(b, k)
				elif kind in (1, 2):
					if kind == 1: k += 1
					flags, k = leb(b, k); _, k = leb(b, k)
					if flags & 1: _, k = leb(b, k)
				elif kind == 3: imported += 1; k += 2
		if sid == 6:
			count, k = leb(b, j)
			for g in range(count):
				k += 1
				if b[k]: found.append(imported + g)
				k += 1
				while b[k] != 0x0b:
					op = b[k]; k += 1
					if op in (0x41, 0x42, 0x23): _, k = leb(b, k)
					elif op == 0x43: k += 4
					elif op == 0x44: k += 8
				k += 1
	return found

src, dst, *rest = sys.argv[1:]
b = open(src, 'rb').read()
pairs = [f'gmux_g{g}={g}' for g in mutable_globals(b)] if rest == ['--all-mutable'] else rest
out = bytearray(b[:8])
for sid, i, j, end in sections(b):
	if sid == 7:
		count, k = leb(b, j)
		body = bytearray(uleb(count + len(pairs))) + b[k:end]
		for pair in pairs:
			name, index = pair.split('=')
			body += uleb(len(name)) + name.encode() + b'\x03' + uleb(int(index))
		out += bytes([7]) + uleb(len(body)) + body
	else:
		out += b[i:end]
open(dst, 'wb').write(out)
print(f'{dst}: +{len(pairs)} exports')
