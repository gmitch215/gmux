import { describe, expect, it } from 'vitest';
import { sqlite } from '../../experiments/write-back/scripts/sqlite.ts';
import { decodeSnapshot, DurableStore, encodeSnapshot } from '../../src/worker/durable.ts';
import type { Snapshot } from '../../src/worker/machine/machine.ts';

const PAGE = 0x10000;

/** a memory of `pages` 64 KiB pages, page i filled with byte `fill(i)` (0 leaves it zero) */
function memory(pages: number, fill: (page: number) => number) {
	const m = new Uint8Array(pages * PAGE);
	for (let p = 0; p < pages; p++) m.fill(fill(p), p * PAGE, (p + 1) * PAGE);
	return m;
}

const file = (path: string, text: string) => ({
	path,
	mode: 0o644,
	bytes: new TextEncoder().encode(text)
});

describe('DurableStore checkpoints', () => {
	it('stores only non-zero pages, packed 30 to a row, plus two metadata rows', () => {
		const store = new DurableStore(sqlite());
		const cost = store.writeCheckpoint(
			memory(64, (p) => (p < 40 ? p + 1 : 0)),
			'{}'
		);
		expect(cost.changed).toBe(40);
		expect(cost.rows).toBe(2 + 2);
	});

	it('writes no page rows for an unchanged memory, and one for a changed page', () => {
		const store = new DurableStore(sqlite());
		const m = memory(64, (p) => (p < 40 ? p + 1 : 0));
		store.writeCheckpoint(m, '{}');
		expect(store.writeCheckpoint(m, '{}')).toEqual({ rows: 2, bytes: 0, changed: 0 });
		m[5 * PAGE] = 200;
		const cost = store.writeCheckpoint(m, '{}');
		expect(cost.changed).toBe(1);
		// the old row still holds 29 live pages, so nothing is deleted
		expect(cost.rows).toBe(1 + 2);
	});

	it('deletes a row once every page in it is replaced', () => {
		const store = new DurableStore(sqlite());
		store.writeCheckpoint(
			memory(30, (p) => p + 1),
			'{}'
		);
		const cost = store.writeCheckpoint(
			memory(30, (p) => p + 100),
			'{}'
		);
		expect(cost.rows).toBe(1 + 1 + 2);
	});

	it('counts a page that became zero as changed and stores nothing for it', () => {
		const store = new DurableStore(sqlite());
		store.writeCheckpoint(
			memory(2, () => 7),
			'{}'
		);
		const cost = store.writeCheckpoint(
			memory(2, (p) => (p ? 7 : 0)),
			'{}'
		);
		expect(cost.changed).toBe(1);
		expect(cost.bytes).toBe(0);
	});

	it('restores the last checkpoint exactly, from a store opened again over the same rows', () => {
		const sql = sqlite();
		const m = memory(40, (p) => (p % 3 ? p : 0));
		new DurableStore(sql).writeCheckpoint(m, 'host state');
		m[33 * PAGE + 9] = 1;
		new DurableStore(sql).writeCheckpoint(m, 'later state');
		const recovery = new DurableStore(sql).recover()!;
		expect(recovery.snapshot).toBe('later state');
		const into = new Uint8Array(recovery.image.byteLength).fill(9);
		recovery.image.write(into);
		expect(Buffer.compare(into, m)).toBe(0);
		expect(recovery.files).toEqual([]);
	});

	it('has nothing to restore before the first checkpoint', () => {
		const store = new DurableStore(sqlite());
		store.writeFile(file('/a', 'x'));
		expect(store.recover()).toBeNull();
	});
});

describe('DurableStore files', () => {
	it('writes a small file whole into its record: one row a sync', () => {
		const store = new DurableStore(sqlite());
		expect(store.writeFile(file('/f', 'a'.repeat(3 * 4096)))).toEqual({
			rows: 1,
			bytes: 3 * 4096,
			changed: 3
		});
		expect(store.writeFile(file('/f', 'b'))).toEqual({ rows: 1, bytes: 1, changed: 1 });
	});

	it("writes a large file's changed 4 KiB blocks, 487 to an extent row, and a record row", () => {
		const store = new DurableStore(sqlite());
		// 600 blocks, past the size a record holds whole
		const big = new Uint8Array(600 * 4096).map((_, i) => (i >> 12) & 0xff);
		expect(store.writeFile({ path: '/big', mode: 0o600, bytes: big })).toMatchObject({
			changed: 600,
			rows: 2 + 1
		});
		big[5 * 4096] ^= 1;
		expect(store.writeFile({ path: '/big', mode: 0o600, bytes: big })).toMatchObject({
			changed: 1,
			rows: 1 + 1
		});
		store.writeCheckpoint(new Uint8Array(0), '{}');
		big[599 * 4096 + 7] ^= 1;
		store.writeFile({ path: '/big', mode: 0o600, bytes: big });
		const back = store.recover()!.files[0]!;
		expect(Buffer.compare(back.bytes, big)).toBe(0);
		// shrunk to a small file: every extent row it held goes
		expect(store.writeFile(file('/big', 'tiny')).rows).toBe(1 + 4);
	});

	it('gives back only the files synced after the last checkpoint, as their last sync left them', () => {
		const store = new DurableStore(sqlite());
		store.writeFile(file('/before', 'old'));
		store.writeCheckpoint(
			memory(1, () => 1),
			'{}'
		);
		store.writeFile(file('/after', 'first'));
		store.writeFile(file('/after', 'second, and longer than a block '.repeat(200)));
		store.writeFile(file('/after', 'short'));
		const files = store.recover()!.files;
		expect(files.map((f) => [f.path, new TextDecoder().decode(f.bytes), f.mode])).toEqual([
			['/after', 'short', 0o644]
		]);
	});

	it('keeps the generation across a reopen, so a later checkpoint still covers earlier syncs', () => {
		const sql = sqlite();
		new DurableStore(sql).writeFile(file('/x', 'one'));
		const reopened = new DurableStore(sql);
		expect(reopened.generation).toBe(1);
		reopened.writeCheckpoint(
			memory(1, () => 2),
			'{}'
		);
		expect(new DurableStore(sql).recover()!.files).toEqual([]);
	});

	it('stores an empty file', () => {
		const store = new DurableStore(sqlite());
		store.writeFile(file('/e', 'data'));
		expect(store.writeFile(file('/e', ''))).toEqual({ rows: 1, bytes: 0, changed: 0 });
		store.writeCheckpoint(new Uint8Array(0), '{}');
		store.writeFile(file('/e', ''));
		expect(store.recover()!.files[0]!.bytes.byteLength).toBe(0);
	});

	it('keeps a removal as one row, across a reopen, and frees the extents the file held', () => {
		const sql = sqlite();
		const store = new DurableStore(sql);
		store.writeCheckpoint(new Uint8Array(0), '{}');
		store.writeFile({ path: '/big', mode: 0o600, bytes: new Uint8Array(600 * 4096).fill(3) });
		const gone = { path: '/big', mode: 0, bytes: new Uint8Array(0), removed: true };
		// the record, and both extent rows it held
		expect(store.writeFile(gone).rows).toBe(1 + 2);
		expect(new DurableStore(sql).recover()!.files).toEqual([gone]);
	});

	it('names an extent that went missing', () => {
		const sql = sqlite();
		const store = new DurableStore(sql);
		store.writeCheckpoint(
			memory(1, () => 3),
			'{}'
		);
		sql.exec('DELETE FROM gmux_extent');
		const recovery = store.recover()!;
		expect(() => recovery.image.write(new Uint8Array(PAGE))).toThrow(/extent 1 is missing/);
	});
});

describe('snapshot text', () => {
	it('round-trips host state, its byte and tag arrays included, with the memory left out', () => {
		const snapshot = {
			version: 1,
			memory: new Uint8Array(PAGE),
			scratch: 4,
			now: '123',
			input: [1, 2],
			ready: [],
			cpuZero: 7,
			runners: [{ id: 1, kernelStack: new Uint8Array([1, 2, 3]), userStack: null }],
			owners: new Uint16Array([1, 65535, 3])
		} as unknown as Snapshot;
		const back = decodeSnapshot(encodeSnapshot(snapshot));
		expect(back.memory.byteLength).toBe(0);
		expect(back.runners[0]!.kernelStack).toEqual(new Uint8Array([1, 2, 3]));
		expect(back.owners).toEqual(new Uint16Array([1, 65535, 3]));
		expect({ ...back, memory: null, runners: null, owners: null }).toEqual({
			...snapshot,
			memory: null,
			runners: null,
			owners: null
		});
	});
});
