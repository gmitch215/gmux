import { readFileSync } from 'node:fs';

/**
 * Turns sweep.sh output (`round variant loop ms`) into a table: per loop and variant the runs, the
 * median, the spread ((max - min) / median) and the ratio to the first variant.
 * `node --experimental-strip-types report.ts <sweep output>`
 */
const rows = readFileSync(process.argv[2] ?? '', 'utf8')
	.split('\n')
	.filter((l) => /^\d+ \S+ \S+ \d+$/.test(l))
	.map((l) => l.split(' '));
const variants = [...new Set(rows.map((r) => r[1]!))];
const loops = [...new Set(rows.map((r) => r[2]!))];
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
console.log(
	`| loop | ${variants.map((v) => `${v} ms (runs)`).join(' | ')} | spread | ${variants
		.slice(1)
		.map((v) => `${v} / ${variants[0]}`)
		.join(' | ')} |`
);
console.log(
	`| --- | ${variants.map(() => '---').join(' | ')} | --- | ${variants
		.slice(1)
		.map(() => '---')
		.join(' | ')} |`
);
for (const loop of loops) {
	const runs = variants.map((v) =>
		rows.filter((r) => r[1] === v && r[2] === loop).map((r) => Number(r[3]))
	);
	const med = runs.map(median);
	const spread = runs.map((xs, i) => ((Math.max(...xs) - Math.min(...xs)) / med[i]!) * 100);
	console.log(
		`| ${loop} | ${runs.map((xs, i) => `${med[i]} (${xs.join(', ')})`).join(' | ')} | ${spread.map((s) => `${s.toFixed(1)}%`).join(' / ')} | ` +
			`${med
				.slice(1)
				.map((m) => `${(m / med[0]!).toFixed(3)}`)
				.join(' | ')} |`
	);
}
