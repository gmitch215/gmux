import { appendFileSync, readFileSync } from 'node:fs';
import { customSection, dylinkMemorySize, u32le } from './binary.ts';

/**
 * Appends a gmux.data custom section holding the data size in the plain build's dylink.0, which
 * instrumenting drops, so the host can refuse an exec whose stub maps less than the program needs.
 * `data-note.ts plain.wasm instrumented.wasm`
 */
const [plain, wasm] = process.argv.slice(2);
const size = dylinkMemorySize(readFileSync(plain!));
if (size !== null) {
	appendFileSync(wasm!, customSection('gmux.data', u32le(size)));
	console.log(`${wasm}: data of ${size} bytes`);
}
