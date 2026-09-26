"""makes an instrumented program shareable by every process running it: __memory_base becomes a
mutable import, which the host sets per process, and every mutable global is exported
(gmux_g<index>) so the host can save and restore a process's values around a switch. __table_base
stays immutable: the element segment's offset reads it, and constant expressions cannot read a
mutable global (every process gets table base 0, which the host checks). The gmux.share section
carries the program's data size (the plain build's dylink.0 memory size, which instrumenting drops),
so the host can copy a pristine data image to each new process.
share.py plain.wasm instrumented.wasm out.wasm"""
import os, subprocess, sys

def leb(b, i):
	r = s = 0
	while True:
		x = b[i]; i += 1
		r |= (x & 0x7f) << s; s += 7
		if x < 0x80: return r, i

def data_size(plain):
	"""dylink.0's memory size"""
	i = 8
	while i < len(plain):
		sid = plain[i]; size, j = leb(plain, i + 1)
		if sid == 0:
			n, k = leb(plain, j)
			if plain[k:k + n] == b'dylink.0':
				k += n
				while k < j + size:
					kind = plain[k]; length, k = leb(plain, k + 1)
					if kind == 1: return leb(plain, k)[0]
					k += length
		i = j + size
	sys.exit('no dylink.0 memory size in the plain build')

plain, src, dst = sys.argv[1:]
data = data_size(open(plain, 'rb').read())
b = bytearray(open(src, 'rb').read())
i = 8
flipped = []
while i < len(b):
	sid = b[i]; size, j = leb(b, i + 1)
	if sid == 2:
		count, k = leb(b, j)
		for _ in range(count):
			n, k = leb(b, k); module = bytes(b[k:k + n]); k += n
			n, k = leb(b, k); name = bytes(b[k:k + n]).decode(); k += n
			kind = b[k]; k += 1
			if kind == 0: _, k = leb(b, k)
			elif kind in (1, 2):
				if kind == 1: k += 1
				flags, k = leb(b, k); _, k = leb(b, k)
				if flags & 1: _, k = leb(b, k)
			elif kind == 3:
				if module == b'env' and name == '__memory_base' and b[k + 1] == 0:
					b[k + 1] = 1
					flipped.append(name)
				k += 2
	i = j + size
if b'__gmux_dlopen' in b:
	sys.exit(f'{src}: calls dlopen, whose libraries are per instance')
if flipped != ['__memory_base']:
	sys.exit(f'{src}: expected an immutable __memory_base import')
tmp = dst + '.tmp'
open(tmp, 'wb').write(b)
here = os.path.dirname(os.path.abspath(__file__))
subprocess.run([sys.executable, os.path.join(here, 'export-globals.py'), tmp, dst, '--all-mutable'], check=True,
               stdout=subprocess.DEVNULL)
os.remove(tmp)
# the mark the host shares by, holding the data size (little-endian u32)
name = b'gmux.share'
open(dst, 'ab').write(bytes([0, len(name) + 5, len(name)]) + name + data.to_bytes(4, 'little'))
