#!/usr/bin/env python3
"""prints the field name of every import (or, with --exports, every function export) in a wasm module"""
import sys

def leb(b, i):
	r = s = 0
	while True:
		x = b[i]; i += 1
		r |= (x & 0x7f) << s; s += 7
		if x < 0x80: return r, i

def name(b, i):
	n, i = leb(b, i)
	return b[i:i + n].decode(), i + n

def imports(b):
	if b[:4] != b'\0asm': raise SystemExit('not wasm')
	i = 8
	while i < len(b):
		sid = b[i]; size, i = leb(b, i + 1); end = i + size
		if sid == 2:
			count, i = leb(b, i)
			for _ in range(count):
				_, i = name(b, i); field, i = name(b, i)
				kind = b[i]; i += 1
				if kind == 0: _, i = leb(b, i)
				elif kind == 1:
					i += 1; flags, i = leb(b, i); _, i = leb(b, i)
					if flags & 1: _, i = leb(b, i)
				elif kind == 2:
					flags, i = leb(b, i); _, i = leb(b, i)
					if flags & 1: _, i = leb(b, i)
				elif kind == 3: i += 2
				yield field
		i = end

def exports(b):
	i = 8
	while i < len(b):
		sid = b[i]; size, i = leb(b, i + 1); end = i + size
		if sid == 7:
			count, i = leb(b, i)
			for _ in range(count):
				field, i = name(b, i)
				kind = b[i]; _, i = leb(b, i + 1)
				if kind == 0: yield field
		i = end

if __name__ == '__main__':
	data = open(sys.argv[-1], 'rb').read()
	for f in (exports(data) if '--exports' in sys.argv else imports(data)): print(f)
