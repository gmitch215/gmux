import { decodeSnapshot } from './durable.ts';
import type { Snapshot } from './machine/machine.ts';

/**
 * A bootstrap image: one machine checkpointed after boot (scripts/bootstrap.ts), shipped with the
 * site's static assets, which a machine with nothing stored restores instead of booting. Memory is
 * cut into chunks of 64 KiB blocks and only the blocks holding a nonzero byte are kept, so a
 * machine that is mostly free pages ships little. An image serves only the build it was taken from
 * (the manifest's `image` hash) and the same command line and size
 */
export interface BootstrapIndex {
	version: 1;
	/** build/kernel/manifest.json's `image`: the kernel, programs and initramfs it was taken with */
	image: string;
	cmdline: string;
	maximumPages: number;
	/** the memory's size in bytes */
	byteLength: number;
	/** bytes of memory each chunk file covers */
	chunkBytes: number;
	/** per chunk, the blocks it holds (index within the chunk, in file order); empty: no file */
	blocks: number[][];
	/** the host state (durable.ts encodeSnapshot) */
	snapshot: string;
}

export const BLOCK = 0x10000;
/**
 * bytes of memory a chunk covers: a lazy restore reads many short runs (kernel pages between the
 * processes' deferred ones), so chunks are small and the last few read are kept
 */
export const CHUNK = 16 * BLOCK;
const KEPT = 4;

/** the chunk files of `memory` and their index entries */
export function packImage(
	memory: Uint8Array,
	chunkBytes = CHUNK
): { blocks: number[][]; chunks: Uint8Array[] } {
	const blocks: number[][] = [];
	const chunks: Uint8Array[] = [];
	for (let at = 0; at < memory.byteLength; at += chunkBytes) {
		const held: number[] = [];
		for (let b = 0; b * BLOCK < chunkBytes && at + b * BLOCK < memory.byteLength; b++) {
			const block = memory.subarray(at + b * BLOCK, at + (b + 1) * BLOCK);
			if (block.some((x) => x !== 0)) held.push(b);
		}
		const file = new Uint8Array(held.length * BLOCK);
		held.forEach((b, i) =>
			file.set(memory.subarray(at + b * BLOCK, at + (b + 1) * BLOCK), i * BLOCK)
		);
		blocks.push(held);
		chunks.push(file);
	}
	return { blocks, chunks };
}

/** whether an image may restore into the site's machine as it is built now */
export function fits(
	index: BootstrapIndex,
	image: string | undefined,
	cmdline: string,
	maximumPages: number
) {
	return (
		index.version === 1 &&
		!!image &&
		index.image === image &&
		index.cmdline === cmdline &&
		index.maximumPages === maximumPages
	);
}

/**
 * the image's snapshot and a lazy reader over its chunks, which `Machine.restore` takes: a read
 * fetches each chunk it overlaps that holds any block (the last KEPT fetched are reused) and
 * zero-fills the rest
 */
export function bootstrapOf(
	index: BootstrapIndex,
	chunk: (n: number) => Promise<Uint8Array>
): {
	snapshot: Snapshot;
	lazy: { byteLength: number; read(start: number, end: number): Promise<Uint8Array> };
	fetched: () => number;
} {
	let fetched = 0;
	const kept = new Map<number, Uint8Array>();
	const get = async (c: number) => {
		let file = kept.get(c);
		if (file) {
			kept.delete(c);
		} else {
			file = await chunk(c);
			fetched++;
			if (kept.size >= KEPT) kept.delete(kept.keys().next().value!);
		}
		kept.set(c, file);
		return file;
	};
	const read = async (start: number, end: number) => {
		const out = new Uint8Array(end - start);
		for (let c = Math.floor(start / index.chunkBytes); c * index.chunkBytes < end; c++) {
			const held = index.blocks[c] ?? [];
			const base = c * index.chunkBytes;
			const wanted = held
				.map((b, i) => ({ b, i, at: base + b * BLOCK }))
				.filter(({ at }) => at + BLOCK > start && at < end);
			if (!wanted.length) continue;
			const file = await get(c);
			for (const { i, at } of wanted) {
				const from = Math.max(at, start);
				const to = Math.min(at + BLOCK, end);
				out.set(
					file.subarray(i * BLOCK + (from - at), i * BLOCK + (to - at)),
					from - start
				);
			}
		}
		return out;
	};
	return {
		snapshot: decodeSnapshot(index.snapshot),
		lazy: { byteLength: index.byteLength, read },
		fetched: () => fetched
	};
}
