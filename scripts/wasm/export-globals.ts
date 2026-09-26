import { readFileSync, writeFileSync } from 'node:fs';
import { concat, readLeb, sections, skipImport, uleb, utf8 } from './binary.ts';

/** indices of mutable globals, imported globals counted first as the index space requires */
function mutableGlobals(b: Uint8Array): number[] {
	let imported = 0;
	const found: number[] = [];
	for (const [id, , start] of sections(b)) {
		if (id === 2) {
			let [count, k] = readLeb(b, start);
			while (count--) {
				for (let name = 0; name < 2; name++) {
					const [n, at] = readLeb(b, k);
					k = at + n;
				}
				const kind = b[k++]!;
				if (kind === 3) imported++;
				k = skipImport(b, kind, k);
			}
		}
		if (id === 6) {
			let [count, k] = readLeb(b, start);
			for (let g = 0; g < count; g++) {
				k++;
				if (b[k]) found.push(imported + g);
				k++;
				while (b[k] !== 0x0b) {
					const op = b[k++]!;
					if (op === 0x41 || op === 0x42 || op === 0x23) k = readLeb(b, k)[1];
					else if (op === 0x43) k += 4;
					else if (op === 0x44) k += 8;
				}
				k++;
			}
		}
	}
	return found;
}

/** the module with global exports appended: `name=index` pairs, or every mutable global as gmux_g<index> */
export function exportGlobals(b: Uint8Array, rest: string[]): { out: Uint8Array; added: number } {
	const pairs =
		rest.length === 1 && rest[0] === '--all-mutable'
			? mutableGlobals(b).map((g) => `gmux_g${g}=${g}`)
			: rest;
	const parts: Uint8Array[] = [b.subarray(0, 8)];
	for (const [id, i, start, end] of sections(b)) {
		if (id !== 7) {
			parts.push(b.subarray(i, end));
			continue;
		}
		const [count, k] = readLeb(b, start);
		const body = [uleb(count + pairs.length), b.subarray(k, end)];
		for (const pair of pairs) {
			const [name, index] = pair.split('=');
			body.push(
				uleb(name!.length),
				utf8.encode(name!),
				Uint8Array.of(3),
				uleb(Number(index))
			);
		}
		const joined = concat(body);
		parts.push(Uint8Array.of(7), uleb(joined.length), joined);
	}
	return { out: concat(parts), added: pairs.length };
}

if (import.meta.main) {
	const [src, dst, ...rest] = process.argv.slice(2);
	const { out, added } = exportGlobals(readFileSync(src!), rest);
	writeFileSync(dst!, out);
	console.log(`${dst}: +${added} exports`);
}
