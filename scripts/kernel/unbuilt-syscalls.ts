import { readFileSync } from 'node:fs';

/**
 * The syscall numbers whose table entry is sys_ni_syscall in a kernel build: a symbol in System.map
 * at sys_ni_syscall's address is a COND_SYSCALL stub nothing built replaced.
 * `unbuilt-syscalls.ts <System.map> <syscall_table.i>`
 */
const [systemMap, tableI] = process.argv.slice(2);
const symbols = new Map<string, Set<string>>();
for (const line of readFileSync(systemMap!, 'utf8').split('\n')) {
	const parts = line.trim().split(/\s+/);
	if (parts.length !== 3) continue;
	if (!symbols.has(parts[0]!)) symbols.set(parts[0]!, new Set());
	symbols.get(parts[0]!)!.add(parts[2]!);
}
const ni = [...symbols].find(([, names]) => names.has('sys_ni_syscall'))![1];
const entries = new Map<number, string>();
// later entries override earlier ones for the same number (the arch's wasm32_* variants)
for (const m of readFileSync(tableI!, 'utf8').matchAll(
	/\[(\d+)\] = \(void \(\*\)\(void\)\)\(void\*\)\((\w+)\)/g
))
	entries.set(Number(m[1]), m[2]!);
for (const nr of [...entries.keys()].sort((a, b) => a - b))
	if (ni.has(entries.get(nr)!)) console.log(nr, entries.get(nr));
