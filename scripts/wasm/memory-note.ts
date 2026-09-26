import { appendFileSync, readFileSync } from 'node:fs';
import { customSection, readLeb, sections, skipImport, u32le } from './binary.ts';

/**
 * Appends a gmux.memory custom section holding the imported memory's initial page count, which the
 * host needs before instantiating and can read from a compiled Module (customSections).
 * `memory-note.ts vmlinux.wasm`
 */
function initialPages(b: Uint8Array): number {
	for (const [id, , start] of sections(b)) {
		if (id !== 2) continue;
		let [count, j] = readLeb(b, start);
		while (count--) {
			for (let name = 0; name < 2; name++) {
				const [n, k] = readLeb(b, j);
				j = k + n;
			}
			const kind = b[j++]!;
			if (kind === 2) return readLeb(b, readLeb(b, j)[1])[0];
			j = skipImport(b, kind, j);
		}
	}
	throw new Error('no imported memory');
}

const path = process.argv[2]!;
const pages = initialPages(readFileSync(path));
appendFileSync(path, customSection('gmux.memory', u32le(pages)));
console.log(`${path}: gmux.memory = ${pages} pages`);
