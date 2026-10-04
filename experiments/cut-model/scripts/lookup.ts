import type { Row } from './model.ts';

/**
 * The block-cache lookup as a function of the cache's working set. `ws-gen.ts` guests hold B blocks and
 * dispatch over H of them through the cache; a guest runs at two lengths, so the slope of time over
 * dispatches leaves out the decoding pass. The table keeps those slopes; a program's lookup cost is
 * read from them at its own (blocks held, blocks that make up its dispatches).
 */

export interface WsPoint {
	/** blocks held */
	B: number;
	/** blocks dispatched over */
	H: number;
	/** ns a dispatch (a block-cache lookup plus the block's four ops) at the longer run */
	ns: number;
}

const key = (r: Row) => r.workload.replace(/-(7|31)$/, '');

/** ns a dispatch, from the slope between a guest's short and long run, for the rows of one arm */
export function slopes(rows: Row[], arm: string) {
	const out = new Map<string, number>();
	const mine = rows.filter((r) => r.arm === arm);
	for (const r of mine.filter((r) => r.workload.endsWith('-31'))) {
		const s = mine.find((o) => o.workload === `${key(r)}-7`);
		if (!s || r.blocks <= s.blocks) continue;
		out.set(key(r), ((r.wall - s.wall) * 1e9) / (r.blocks - s.blocks));
	}
	return out;
}

/** the `ind` guests (`ind-<B>-<H>`) as points */
export function wsPoints(rows: Row[], arm = 'base'): WsPoint[] {
	return [...slopes(rows, arm)]
		.filter(([k]) => k.startsWith('ind-'))
		.map(([k, ns]) => {
			const [, b, h] = k.split('-');
			return { B: Number(b), H: Number(h), ns };
		});
}

/** ns a build without chaining adds to a dispatch over one with it, on the `dirh` (random order) or `dirs` (decode order) guests (`<mode>-<B>-<H>`): a lookup at (B, H) */
export function dirhPoints(rows: Row[], mode = 'dirh'): WsPoint[] {
	const base = slopes(rows, 'base');
	const chain = slopes(rows, 'chain');
	const out: WsPoint[] = [];
	for (const [k, v] of base) {
		const c = chain.get(k);
		const m = new RegExp(`^${mode}-(\\d+)-(\\d+)$`).exec(k);
		if (c === undefined || !m) continue;
		out.push({ B: Number(m[1]), H: Number(m[2]), ns: v - c });
	}
	return out.sort((x, y) => x.B - y.B || x.H - y.H);
}

/** ns saved for each lookup a chaining build avoids, on the `dir` guests (`dir-<B>-<B>`), by B */
export function dirSavings(rows: Row[]) {
	const base = slopes(rows, 'base');
	const chain = slopes(rows, 'chain');
	const out: { B: number; ns: number }[] = [];
	for (const [k, v] of base) {
		const c = chain.get(k);
		if (c === undefined || !k.startsWith('dir-')) continue;
		out.push({ B: Number(k.split('-')[1]), ns: v - c });
	}
	return out.sort((a, b) => a.B - b.B);
}

const lerp = (x: number, x0: number, x1: number, y0: number, y1: number) => (x1 === x0 ? y0 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0));

/** piecewise linear in log2 of the abscissa, held at the end values outside the measured range */
function along(pts: { x: number; y: number }[], x: number) {
	const s = [...pts].sort((a, b) => a.x - b.x);
	if (x <= s[0]!.x) return s[0]!.y;
	for (let i = 1; i < s.length; i++) if (x <= s[i]!.x) return lerp(Math.log2(x), Math.log2(s[i - 1]!.x), Math.log2(s[i]!.x), s[i - 1]!.y, s[i]!.y);
	return s[s.length - 1]!.y;
}

/** ns a dispatch at b blocks held and h dispatched over: along H inside the two measured B families around b, then along B */
export function wsAt(points: WsPoint[], b: number, h: number) {
	const sizes = [...new Set(points.map((p) => p.B))].sort((x, y) => x - y);
	const at = (size: number) =>
		along(
			points.filter((p) => p.B === size).map((p) => ({ x: p.H, y: p.ns })),
			Math.min(h, size)
		);
	if (b <= sizes[0]!) return at(sizes[0]!);
	for (let i = 1; i < sizes.length; i++) if (b <= sizes[i]!) return lerp(Math.log2(b), Math.log2(sizes[i - 1]!), Math.log2(sizes[i]!), at(sizes[i - 1]!), at(sizes[i]!));
	return at(sizes[sizes.length - 1]!);
}

/** what one lookup costs at (b, h): the table's small-guest lookup plus what the working set adds over the smallest guest */
export function lookupNs(table: { lookup0: number; points: WsPoint[] }, b: number, h: number) {
	const tiny = table.points.find((p) => p.B === 16 && p.H === 16);
	if (!tiny) throw new Error('no 16 x 16 point in the working-set table');
	return table.lookup0 + wsAt(table.points, b, h) - tiny.ns;
}
