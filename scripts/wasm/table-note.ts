import { appendFileSync, readFileSync } from 'node:fs';
import { customSection, u32le } from './binary.ts';

/**
 * Appends a gmux.table custom section holding the size the program's imported function table must
 * have, read from its wat, so the host can make the table that size (customSections) instead of a
 * fixed 4096 entries. `table-note.ts program.wat program.wasm`
 */
const [wat, wasm] = process.argv.slice(2);
const m = readFileSync(wat!, 'utf8').match(
	/\(import "env" "__indirect_function_table" \(table \S* ?(\d+)/
);
if (m) {
	const entries = Number(m[1]);
	appendFileSync(wasm!, customSection('gmux.table', u32le(entries)));
	console.log(`${wasm}: table of ${entries}`);
}
