/** a LEB128 at `i`: the value and the index after it (sizes and indices, so a number holds them) */
export function readLeb(b: Uint8Array, i: number): [number, number] {
	let value = 0;
	let scale = 1;
	for (;;) {
		const byte = b[i++]!;
		value += (byte & 0x7f) * scale;
		scale *= 128;
		if (byte < 0x80) return [value, i];
	}
}

export function uleb(n: number): Uint8Array {
	const out: number[] = [];
	for (;;) {
		const byte = n % 128;
		n = Math.floor(n / 128);
		out.push(byte | (n ? 0x80 : 0));
		if (!n) return Uint8Array.from(out);
	}
}

/** each section: its id, where it starts, where its contents start, and where it ends */
export function* sections(b: Uint8Array): Generator<[number, number, number, number]> {
	let i = 8;
	while (i < b.length) {
		const id = b[i]!;
		const [size, j] = readLeb(b, i + 1);
		yield [id, i, j, j + size];
		i = j + size;
	}
}

/** the index after one import's descriptor of `kind`, which starts at `k` */
export function skipImport(b: Uint8Array, kind: number, k: number): number {
	if (kind === 0) return readLeb(b, k)[1];
	if (kind === 1 || kind === 2) {
		if (kind === 1) k++;
		const [flags, a] = readLeb(b, k);
		k = readLeb(b, a)[1];
		return flags & 1 ? readLeb(b, k)[1] : k;
	}
	if (kind === 3) return k + 2;
	if (kind === 4) return readLeb(b, k + 1)[1];
	throw new Error(`unknown import kind ${kind}`);
}

export const utf8 = new TextEncoder();
export const text = new TextDecoder();

export function concat(parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

export function u32le(n: number): Uint8Array {
	const out = new Uint8Array(4);
	new DataView(out.buffer).setUint32(0, n, true);
	return out;
}

/** a custom section of `name` holding `payload` */
export function customSection(name: string, payload: Uint8Array): Uint8Array {
	const body = concat([uleb(name.length), utf8.encode(name), payload]);
	return concat([Uint8Array.of(0), uleb(body.length), body]);
}
