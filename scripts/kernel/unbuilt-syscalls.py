#!/usr/bin/env python3
# the syscall numbers whose table entry is sys_ni_syscall in a kernel build: a symbol in System.map at
# sys_ni_syscall's address is a COND_SYSCALL stub nothing built replaced
# usage: unbuilt-syscalls.py <System.map> <syscall_table.i>
import re
import sys

system_map, table = sys.argv[1], sys.argv[2]
symbols = {}
for line in open(system_map):
    parts = line.split()
    if len(parts) == 3:
        symbols.setdefault(parts[0], set()).add(parts[2])
ni = next(addr for addr, names in symbols.items() if "sys_ni_syscall" in names)

entries = {}
# later entries override earlier ones for the same number (the arch's wasm32_* variants)
for nr, name in re.findall(r"\[(\d+)\] = \(void \(\*\)\(void\)\)\(void\*\)\((\w+)\)", open(table).read()):
    entries[int(nr)] = name
for nr in sorted(entries):
    if entries[nr] in symbols[ni]:
        print(nr, entries[nr])
