import { describe, expect, it } from 'vitest';
import {
	BLOCK,
	bootstrapOf,
	fits,
	packImage,
	type BootstrapIndex
} from '../../src/worker/bootstrap.ts';
import { encodeSnapshot } from '../../src/worker/durable.ts';
import type { Snapshot } from '../../src/worker/machine/machine.ts';

/** 40 blocks, 4 per chunk: blocks 1, 2 and 9 hold bytes (9 only its last byte), the rest are zero */
function memory() {
	const m = new Uint8Array(40 * BLOCK);
	m.fill(7, BLOCK, 3 * BLOCK);
	m[10 * BLOCK - 1] = 9;
	return m;
}

function index(m: Uint8Array, chunkBytes = 4 * BLOCK) {
	const { blocks, chunks } = packImage(m, chunkBytes);
	const idx: BootstrapIndex = {
		version: 1,
		image: 'img',
		cmdline: 'c',
		maximumPages: 1,
		byteLength: m.byteLength,
		chunkBytes,
		blocks,
		snapshot: encodeSnapshot({ memory: m, runners: [] } as unknown as Snapshot)
	};
	return { idx, chunks };
}

describe('bootstrap images', () => {
	it('keeps only the blocks holding a nonzero byte, and reads any range back exactly', async () => {
		const m = memory();
		const { idx, chunks } = index(m);
		expect(idx.blocks.slice(0, 3)).toEqual([[1, 2], [], [1]]);
		expect(chunks.reduce((n, c) => n + c.byteLength, 0)).toBe(3 * BLOCK);
		const fetched: number[] = [];
		const b = bootstrapOf(idx, async (n) => (fetched.push(n), chunks[n]!));
		const same = (a: Uint8Array, b: Uint8Array) => Buffer.compare(a, b) === 0;
		expect(same(await b.lazy.read(0, m.byteLength), m)).toBe(true);
		for (const [s, e] of [
			[BLOCK - 3, BLOCK + 5],
			[10 * BLOCK - 2, 10 * BLOCK],
			[4 * BLOCK, 8 * BLOCK]
		] as const)
			expect(same(await b.lazy.read(s, e), m.subarray(s, e))).toBe(true);
		// chunk 1 holds nothing and is never fetched; the others come from the kept few
		expect(fetched).not.toContain(1);
		expect(new Set(fetched)).toEqual(new Set([0, 2]));
		expect(b.fetched()).toBe(2);
		expect(b.snapshot.memory.byteLength).toBe(0);
	});

	it('serves only the build, command line and size it was taken with', () => {
		const { idx } = index(memory());
		expect(fits(idx, 'img', 'c', 1)).toBe(true);
		expect(fits(idx, 'other', 'c', 1)).toBe(false);
		expect(fits(idx, undefined, 'c', 1)).toBe(false);
		expect(fits(idx, 'img', 'c2', 1)).toBe(false);
		expect(fits(idx, 'img', 'c', 2)).toBe(false);
		expect(fits({ ...idx, version: 2 as 1 }, 'img', 'c', 1)).toBe(false);
	});
});
