"""appends a gmux.table custom section holding the size the program's imported function table must
have, read from its wat, so the host can make the table that size (customSections) instead of a
fixed 4096 entries. usage: table-note.py program.wat program.wasm"""
import re
import struct
import sys

wat, wasm = sys.argv[1], sys.argv[2]
m = re.search(r'\(import "env" "__indirect_function_table" \(table \S* ?(\d+)', open(wat).read())
if not m:
    sys.exit(0)
entries = int(m.group(1))
name = b'gmux.table'
payload = struct.pack('<I', entries)
body = bytes([len(name)]) + name + payload
with open(wasm, 'ab') as f:
    f.write(bytes([0, len(body)]) + body)
print(f'{wasm}: table of {entries}')
