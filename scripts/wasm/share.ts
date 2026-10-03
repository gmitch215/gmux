import { readFileSync, writeFileSync } from 'node:fs';
import {
	concat,
	customSection,
	dylinkMemorySize,
	readLeb,
	sections,
	skipImport,
	text,
	u32le
} from './binary.ts';
import { exportGlobals } from './export-globals.ts';

/**
 * Makes an instrumented program shareable by every process running it: __memory_base becomes a
 * mutable import, which the host sets per process, and every mutable global is exported
 * (gmux_g<index>) so the host can save and restore a process's values around a switch. __table_base
 * stays immutable: the element segment's offset reads it, and constant expressions cannot read a
 * mutable global (every process gets table base 0, which the host checks). The gmux.share section
 * carries the program's data size (the plain build's dylink.0 memory size, which instrumenting
 * drops), so the host can copy a pristine data image to each new process.
 * `share.ts plain.wasm instrumented.wasm out.wasm`
 */
const [plain, src, dst] = process.argv.slice(2);
const data = dylinkMemorySize(readFileSync(plain!));
if (data === null) throw new Error('no dylink.0 memory size in the plain build');
const b = new Uint8Array(readFileSync(src!));
const flipped: string[] = [];
for (const [id, , start] of sections(b)) {
	if (id !== 2) continue;
	let [count, k] = readLeb(b, start);
	while (count--) {
		const [mn, m0] = readLeb(b, k);
		const module = text.decode(b.subarray(m0, m0 + mn));
		const [nn, n0] = readLeb(b, m0 + mn);
		const name = text.decode(b.subarray(n0, n0 + nn));
		k = n0 + nn;
		const kind = b[k++]!;
		if (kind === 3 && module === 'env' && name === '__memory_base' && b[k + 1] === 0) {
			b[k + 1] = 1;
			flipped.push(name);
		}
		k = skipImport(b, kind, k);
	}
}
if (Buffer.from(b).includes('__gmux_dlopen'))
	throw new Error(`${src}: calls dlopen, whose libraries are per instance`);
if (flipped.length !== 1 || flipped[0] !== '__memory_base')
	throw new Error(`${src}: expected an immutable __memory_base import`);
// the mark the host shares by, holding the data size (little-endian u32)
const { out } = exportGlobals(b, ['--all-mutable']);
writeFileSync(dst!, concat([out, customSection('gmux.share', u32le(data))]));
