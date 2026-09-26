import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Keeps only the exports the gmux host uses; each export costs JS heap in every task instance.
 * `strip-exports.ts in.wat out.wat name,name,...`
 */
const [src, dst, names] = process.argv.slice(2);
const keep = new Set(names!.split(','));
let kept = 0;
let removed = 0;
const out: string[] = [];
for (const line of readFileSync(src!, 'utf8').split('\n')) {
	const m = line.match(/^\s*\(export "([^"]+)"/);
	if (!m) out.push(line);
	else if (keep.has(m[1]!)) {
		kept++;
		out.push(line);
	} else removed++;
}
writeFileSync(dst!, out.join('\n'));
console.log(`kept ${kept} exports, removed ${removed}`);
