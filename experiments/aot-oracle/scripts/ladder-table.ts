import { readFileSync } from 'node:fs';

/**
 * The ladder's tables from its logs: per workload and arm, r on x86 (Katybug built natively over the
 * binary), r on wasm (the machine over the binary at the wasm scale), and r = r_x86 x r_wasm(F) + r_tail
 * where r_wasm(F) is the native algorithm's own wasm multiplier (the wasm build in the machine over the
 * same source built natively by clang) and r_tail what wasm costs the arm's code beyond it. A step is an
 * arm's r minus the arm above it. F's r x86 is the clang build over the shipped binary.
 *
 * `ladder-table.ts <ladder.sh log> <ladder.ts log> <ladder-f-native.sh log at ladder.sh's scale> <the same at ladder.ts's scale>`
 */
const [nativeLog = '', wasmLog = '', fx86Log = '', fwasmLog = '', ordersLog = ''] = process.argv.slice(2);
const rows = (path: string) =>
	readFileSync(path, 'utf8')
		.split('\n')
		.filter((l) => l.startsWith('| ') && !l.includes('---'))
		.map((l) => l.split('|').map((c) => c.trim()).slice(1, -1));
const median = (rs: string[][], w: string, a: string, col: number) => {
	const r = rs.find((x) => x[0] === w && x[1] === a);
	return r ? Number(r[col]) : NaN;
};
const native = rows(nativeLog).filter((r) => /^\d/.test(r[3] ?? '') && r.length === 5 && !r[2]!.includes('exact'));
const bytes = rows(nativeLog).filter((r) => r.length === 5 && (r[2] === 'exact' || r[2]!.includes('DIFFERS')));
const wasm = rows(wasmLog).filter((r) => r.length === 6 && /^\d/.test(r[3]!));
const fx86 = rows(fx86Log);
const fwasm = rows(fwasmLog);
const orders = ordersLog ? rows(ordersLog).filter((r) => r.length === 5 && /^\d/.test(r[3] ?? '')) : [];
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '-');
const order = ['plain', 'A', 'B0', 'B', 'C0', 'C', 'D', 'E'];
console.log('| workload | arm | r x86 | x86 order spread | r wasm | wasm / x86 | r_tail | step x86 | step wasm | region text bytes | IR and table bytes | output |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const w of ['sha256', 'factor', 'sqlite']) {
	const ref86 = median(fx86, w, 'shipped', 3);
	const refW = median(fwasm, w, 'shipped', 3) * 1000;
	const fW = median(wasm, w, 'F', 3) / (median(fwasm, w, 'clang', 3) * 1000);
	let prev86 = NaN;
	let prevW = NaN;
	for (const a of [...order, 'F']) {
		const mean = median(orders, w, a, 3);
		const r86 = a === 'F' ? median(fx86, w, 'clang', 3) / ref86 : Number.isFinite(mean) ? mean / ref86 : median(native, w, a, 3) / ref86;
		const spread = orders.find((x) => x[0] === w && x[1] === a)?.[4] ?? '-';
		const rW = median(wasm, w, a, 3) / refW;
		const tail = rW - r86 * fW;
		const b = bytes.find((x) => x[0] === w && x[1] === a);
		const out = b?.[2] ?? wasm.find((x) => x[0] === w && x[1] === a)?.[5] ?? '-';
		const chain = ['A', 'B', 'C', 'D', 'E', 'F'].includes(a);
		console.log(
			`| ${w} | ${a} | ${f2(r86)} | ${spread} | ${f2(rW)} | ${f2(rW / r86)} | ${a === 'F' || a === 'plain' ? '-' : f2(tail)} | ${chain && Number.isFinite(prev86) ? f2(r86 - prev86) : '-'} | ${chain && Number.isFinite(prevW) ? f2(rW - prevW) : '-'} | ${b?.[3] ?? '-'} | ${b?.[4] ?? '-'} | ${out} |`
		);
		if (chain) {
			prev86 = r86;
			prevW = rW;
		}
	}
}
