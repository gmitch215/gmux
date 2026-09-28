import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { Snapshot, SyncedFile } from './machine/machine.ts';

/** the part of a Durable Object's `ctx.storage.sql` the store uses */
export interface Sql {
	exec(
		query: string,
		...bindings: (string | number | ArrayBuffer | Uint8Array | null)[]
	): { toArray(): Record<string, unknown>[]; rowsWritten: number };
}

/** what one write cost */
export interface Written {
	/** rows written, deletes included: what the rows-written meter counts */
	rows: number;
	/** bytes put into rows */
	bytes: number;
	/** 64 KiB pages or 4 KiB file blocks that changed */
	changed: number;
}

/** what a machine restores from: the last checkpoint, and the files synced after it */
export interface Recovery {
	/** the snapshot's host state as the checkpoint stored it */
	snapshot: string;
	/** writes the checkpoint's memory into a machine's (Machine.restore's `image`) */
	image: { byteLength: number; write(into: Uint8Array): void };
	/** every file synced since the checkpoint, as its last sync left it */
	files: SyncedFile[];
}

// a Durable Object row holds at most 2 MB
const ROW = 2_000_000;
const PAGE = 0x10000;
const BLOCK = 0x1000;
// a file this small is written whole into its own record row: one row a sync, and no extents
const INLINE = 1_900_000;
const IMAGE = 0;
const FILE = 1;

/** where a page or block lives: its extent row (0 for all zeroes), its slot there, its hash */
interface Place {
	extent: number;
	slot: number;
	hash: bigint;
}

interface FileRecord {
	gen: number;
	mode: number;
	size: number;
	blocks: Place[];
}

function digest(bytes: Uint8Array): bigint {
	const h = createHash('sha256').update(bytes).digest();
	return new DataView(h.buffer, h.byteOffset, 8).getBigUint64(0, true);
}

function zero(bytes: Uint8Array): boolean {
	const words = new BigUint64Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 8);
	for (let i = 0; i < words.length; i++) if (words[i]) return false;
	return true;
}

/** a place table as bytes: 16 per entry */
function packPlaces(places: Place[]): Uint8Array {
	const out = new Uint8Array(places.length * 16);
	const view = new DataView(out.buffer);
	places.forEach((p, i) => {
		view.setUint32(i * 16, p.extent, true);
		view.setUint32(i * 16 + 4, p.slot, true);
		view.setBigUint64(i * 16 + 8, p.hash, true);
	});
	return out;
}

function unpackPlaces(bytes: Uint8Array): Place[] {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const out: Place[] = [];
	for (let at = 0; at + 16 <= bytes.byteLength; at += 16)
		out.push({
			extent: view.getUint32(at, true),
			slot: view.getUint32(at + 4, true),
			hash: view.getBigUint64(at + 8, true)
		});
	return out;
}

const bytesOf = (v: unknown) => new Uint8Array(v as ArrayBuffer);

/** a snapshot's host state as text, its memory left out (the store keeps that as pages) */
export function encodeSnapshot(snapshot: Snapshot): string {
	return JSON.stringify({ ...snapshot, memory: snapshot.memory.byteLength }, (_, v) => {
		if (v instanceof Uint16Array)
			return { $u16: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64') };
		if (v instanceof Uint8Array) return { $u8: Buffer.from(v).toString('base64') };
		return v;
	});
}

/** the inverse of `encodeSnapshot`, with an empty memory: restore writes it from the image */
export function decodeSnapshot(text: string): Snapshot {
	const parsed = JSON.parse(text, (_, v) => {
		if (v && typeof v === 'object' && typeof v.$u8 === 'string')
			return new Uint8Array(Buffer.from(v.$u8, 'base64'));
		if (v && typeof v === 'object' && typeof v.$u16 === 'string') {
			const b = Buffer.from(v.$u16, 'base64');
			return new Uint16Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
		}
		return v;
	});
	return { ...parsed, memory: new Uint8Array(0) };
}

/**
 * A machine's durable state in SQLite, written back rather than rewritten: a checkpoint stores only
 * the 64 KiB pages whose hash changed, packed into extent rows of up to 2 MB, and an fsync writes a
 * small file whole into its record row, or a large one's changed 4 KiB blocks into extent rows. An
 * extent row is never rewritten in place; one whose every page or block was replaced is deleted.
 *
 * Every write takes the next generation. A restore takes the last checkpoint and every file synced
 * after it, which `Machine.restore` writes back before any program's next syscall.
 */
export class DurableStore {
	private gen = 0;
	private nextExtent = 1;
	private pages: Place[] = [];
	private readonly files = new Map<string, FileRecord>();
	private readonly live = new Map<number, number>();

	private readonly sql: Sql;

	constructor(sql: Sql) {
		this.sql = sql;
		sql.exec(
			'CREATE TABLE IF NOT EXISTS gmux_extent (id INTEGER PRIMARY KEY, kind INTEGER, data BLOB)'
		);
		sql.exec(
			'CREATE TABLE IF NOT EXISTS gmux_file (path TEXT PRIMARY KEY, gen INTEGER, mode INTEGER, size INTEGER, places BLOB, data BLOB)'
		);
		sql.exec('CREATE TABLE IF NOT EXISTS gmux_meta (k TEXT PRIMARY KEY, v BLOB)');
		const meta = (k: string) =>
			sql.exec('SELECT v FROM gmux_meta WHERE k = ?', k).toArray()[0]?.v;
		const checkpoint = meta('checkpoint');
		if (checkpoint !== undefined) this.gen = Number(String(checkpoint).split('\n', 1)[0]);
		this.nextExtent =
			Number(sql.exec('SELECT max(id) AS m FROM gmux_extent').toArray()[0]?.m ?? 0) + 1;
		const pages = meta('pages');
		if (pages) this.pages = unpackPlaces(bytesOf(pages));
		for (const r of sql.exec('SELECT path, gen, mode, size, places FROM gmux_file').toArray())
			this.files.set(String(r.path), {
				gen: Number(r.gen),
				mode: Number(r.mode),
				size: Number(r.size),
				blocks: unpackPlaces(bytesOf(r.places))
			});
		for (const p of this.pages) this.hold(p.extent, 1);
		for (const f of this.files.values()) {
			for (const b of f.blocks) this.hold(b.extent, 1);
			this.gen = Math.max(this.gen, f.gen);
		}
	}

	/** the generation of the last write */
	get generation(): number {
		return this.gen;
	}

	/** whether a checkpoint is stored to restore from */
	get checkpointed(): boolean {
		return (
			this.sql.exec("SELECT 1 AS one FROM gmux_meta WHERE k = 'checkpoint'").toArray()
				.length > 0
		);
	}

	private hold(extent: number, n: number) {
		if (extent) this.live.set(extent, (this.live.get(extent) ?? 0) + n);
	}

	/** drops a reference to an extent, deleting its row with the last one */
	private release(extent: number, cost: Written) {
		if (!extent) return;
		const left = (this.live.get(extent) ?? 0) - 1;
		if (left > 0) {
			this.live.set(extent, left);
			return;
		}
		this.live.delete(extent);
		cost.rows += this.sql.exec('DELETE FROM gmux_extent WHERE id = ?', extent).rowsWritten;
	}

	/** packs `items` (index, bytes) of `size` each into extent rows; answers where each landed */
	private pack(kind: number, size: number, items: [number, Uint8Array][], cost: Written) {
		const per = Math.floor((ROW - 4) / (size + 4));
		const placed = new Map<number, { extent: number; slot: number }>();
		// one row's buffer for every row: the binding is copied when the statement runs
		const buffer = new Uint8Array(4 + Math.min(per, items.length) * (size + 4));
		for (let at = 0; at < items.length; at += per) {
			const group = items.slice(at, at + per);
			const out = buffer.subarray(0, 4 + group.length * 4 + group.length * size);
			const view = new DataView(out.buffer);
			view.setUint32(0, group.length, true);
			const id = this.nextExtent++;
			group.forEach(([index, bytes], slot) => {
				view.setUint32(4 + slot * 4, index, true);
				out.set(bytes, 4 + group.length * 4 + slot * size);
				placed.set(index, { extent: id, slot });
			});
			cost.rows += this.sql.exec(
				'INSERT INTO gmux_extent (id, kind, data) VALUES (?, ?, ?)',
				id,
				kind,
				out
			).rowsWritten;
			cost.bytes += out.byteLength;
		}
		return placed;
	}

	private setMeta(k: string, v: string | Uint8Array, cost: Written) {
		cost.rows += this.sql.exec(
			'INSERT OR REPLACE INTO gmux_meta (k, v) VALUES (?, ?)',
			k,
			v
		).rowsWritten;
	}

	/**
	 * a checkpoint: the pages of `memory` that changed since the last one, and `snapshot`, the host
	 * state that goes with them. Zero pages cost nothing to store
	 */
	writeCheckpoint(memory: Uint8Array, snapshot: string): Written {
		const cost: Written = { rows: 0, bytes: 0, changed: 0 };
		const count = memory.byteLength / PAGE;
		const changed: [number, Uint8Array][] = [];
		const next: Place[] = [];
		const old = this.pages;
		for (let p = 0; p < count; p++) {
			const bytes = memory.subarray(p * PAGE, (p + 1) * PAGE);
			const was = old[p];
			if (zero(bytes)) {
				next[p] = { extent: 0, slot: 0, hash: 0n };
				if (was?.extent) cost.changed++;
				continue;
			}
			const hash = digest(bytes);
			if (was?.extent && was.hash === hash) {
				next[p] = was;
				continue;
			}
			next[p] = { extent: 0, slot: 0, hash };
			// a view: the memory holds still while it is written, and a copy of every page would not fit
			changed.push([p, bytes]);
		}
		cost.changed += changed.length;
		for (const [p, { extent, slot }] of this.pack(IMAGE, PAGE, changed, cost)) {
			next[p] = { extent, slot, hash: next[p]!.hash };
			this.hold(extent, 1);
		}
		for (let p = 0; p < Math.max(old.length, count); p++)
			if (old[p] && old[p]!.extent && old[p] !== next[p]) this.release(old[p]!.extent, cost);
		this.pages = next;
		this.gen++;
		this.setMeta('pages', packPlaces(next), cost);
		// the checkpoint's generation leads its snapshot, one row for both
		this.setMeta('checkpoint', `${this.gen}\n${snapshot}`, cost);
		return cost;
	}

	/** an fsync: the file's blocks that changed since its last sync, and its record; a removal is one row */
	writeFile(file: SyncedFile): Written {
		const cost: Written = { rows: 0, bytes: 0, changed: 0 };
		const was = this.files.get(file.path);
		const count = Math.ceil(file.bytes.byteLength / BLOCK);
		if (file.bytes.byteLength <= INLINE) {
			for (const old of was?.blocks ?? []) this.release(old.extent, cost);
			this.gen++;
			const record = {
				gen: this.gen,
				// a removed file is a record of mode -1
				mode: file.removed ? -1 : file.mode,
				size: file.bytes.byteLength,
				blocks: []
			};
			this.files.set(file.path, record);
			cost.rows += this.sql.exec(
				'INSERT OR REPLACE INTO gmux_file (path, gen, mode, size, places, data) VALUES (?, ?, ?, ?, ?, ?)',
				file.path,
				record.gen,
				record.mode,
				record.size,
				new Uint8Array(0),
				file.bytes
			).rowsWritten;
			cost.bytes += file.bytes.byteLength;
			cost.changed = count;
			return cost;
		}
		const blocks: Place[] = [];
		const changed: [number, Uint8Array][] = [];
		for (let b = 0; b < count; b++) {
			const bytes = new Uint8Array(BLOCK);
			bytes.set(file.bytes.subarray(b * BLOCK, (b + 1) * BLOCK));
			const hash = digest(bytes);
			const old = was?.blocks[b];
			if (old && old.hash === hash) {
				blocks[b] = old;
				continue;
			}
			blocks[b] = { extent: 0, slot: 0, hash };
			changed.push([b, bytes]);
		}
		cost.changed = changed.length;
		for (const [b, { extent, slot }] of this.pack(FILE, BLOCK, changed, cost)) {
			blocks[b] = { extent, slot, hash: blocks[b]!.hash };
			this.hold(extent, 1);
		}
		for (const [b, old] of (was?.blocks ?? []).entries())
			if (old !== blocks[b]) this.release(old.extent, cost);
		this.gen++;
		const record = { gen: this.gen, mode: file.mode, size: file.bytes.byteLength, blocks };
		this.files.set(file.path, record);
		cost.rows += this.sql.exec(
			'INSERT OR REPLACE INTO gmux_file (path, gen, mode, size, places, data) VALUES (?, ?, ?, ?, ?, NULL)',
			file.path,
			record.gen,
			record.mode,
			record.size,
			packPlaces(blocks)
		).rowsWritten;
		return cost;
	}

	/** forgets the machine: every row goes, and the next checkpoint starts the store again */
	clear(): Written {
		const cost: Written = { rows: 0, bytes: 0, changed: 0 };
		for (const table of ['gmux_extent', 'gmux_file', 'gmux_meta'])
			cost.rows += this.sql.exec(`DELETE FROM ${table}`).rowsWritten;
		this.gen = 0;
		this.nextExtent = 1;
		this.pages = [];
		this.files.clear();
		this.live.clear();
		return cost;
	}

	/** reads rows of extents back into fixed-size items: extent id -> slot -> bytes */
	private extents(ids: Set<number>, size: number): Map<number, Uint8Array[]> {
		const out = new Map<number, Uint8Array[]>();
		for (const id of ids) {
			const row = this.sql.exec('SELECT data FROM gmux_extent WHERE id = ?', id).toArray()[0];
			if (!row) throw new Error(`durable store: extent ${id} is missing`);
			const data = bytesOf(row.data);
			const n = new DataView(data.buffer, data.byteOffset).getUint32(0, true);
			const slots: Uint8Array[] = [];
			for (let s = 0; s < n; s++)
				slots.push(data.subarray(4 + n * 4 + s * size, 4 + n * 4 + (s + 1) * size));
			out.set(id, slots);
		}
		return out;
	}

	/** the last checkpoint and the files synced after it, or null before the first checkpoint */
	recover(): Recovery | null {
		const row = this.sql.exec("SELECT v FROM gmux_meta WHERE k = 'checkpoint'").toArray()[0];
		if (!row) return null;
		const text = String(row.v);
		const cut = text.indexOf('\n');
		const at = Number(text.slice(0, cut));
		const pages = this.pages;
		const image = {
			byteLength: pages.length * PAGE,
			write: (into: Uint8Array) => {
				// one extent row in memory at a time: all of them at once would be a second machine
				const by = new Map<number, number[]>();
				pages.forEach((p, i) => {
					if (!p.extent) return void into.fill(0, i * PAGE, (i + 1) * PAGE);
					const list = by.get(p.extent) ?? [];
					list.push(i);
					by.set(p.extent, list);
				});
				for (const [id, list] of by) {
					const slots = this.extents(new Set([id]), PAGE).get(id)!;
					for (const i of list) into.set(slots[pages[i]!.slot]!, i * PAGE);
				}
			}
		};
		const files: SyncedFile[] = [];
		for (const [path, f] of this.files) {
			if (f.gen <= at) continue;
			if (f.mode < 0) {
				files.push({ path, mode: 0, bytes: new Uint8Array(0), removed: true });
				continue;
			}
			if (!f.blocks.length) {
				const row = this.sql
					.exec('SELECT data FROM gmux_file WHERE path = ?', path)
					.toArray()[0];
				files.push({
					path,
					mode: f.mode,
					bytes: bytesOf(row?.data ?? new Uint8Array(0)).slice()
				});
				continue;
			}
			const extents = this.extents(new Set(f.blocks.map((b) => b.extent)), BLOCK);
			const bytes = new Uint8Array(f.blocks.length * BLOCK);
			f.blocks.forEach((b, i) => bytes.set(extents.get(b.extent)![b.slot]!, i * BLOCK));
			files.push({ path, mode: f.mode, bytes: bytes.slice(0, f.size) });
		}
		return { snapshot: text.slice(cut + 1), image, files };
	}
}
