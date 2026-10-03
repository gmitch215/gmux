import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A guest's profile record: the heat (weighted call graph), the timing of its two ends, the plan and
 * the target sets derived from them, and optionally the mined fusion catalog. Kept at
 * `<dir>/<sha256 of the module>.json` with the provenance it was made under, and used only while that
 * provenance is the current one. The burrow half is what burrow's own artifact keys a catalog by
 * (version, wasm3 pin, hash of patches, shim, runtime, generator, profiler and miner); `tools` hashes
 * the scripts that produce a record and `params` the planner's arguments.
 */
export const FORMAT = 1;

export interface Provenance {
	format: number;
	burrow: string;
	wasm3: string;
	burrowTools: string;
	tools: string;
	params: string;
}

export interface ProfileRecord {
	graph: string;
	ends: string;
	plan: string;
	sets: string;
	catalog?: string;
}

interface Stored {
	module: string;
	provenance: Provenance;
	record: ProfileRecord;
}

const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

export const moduleKey = (wasm: Uint8Array) => sha256(wasm);

/** a hash of the named files' names and contents, in name order */
export function hashFiles(files: string[]): string {
	const h = createHash('sha256');
	for (const f of [...files].sort()) h.update(f).update(readFileSync(f));
	return h.digest('hex');
}

export function save(dir: string, wasm: Uint8Array, record: ProfileRecord, prov: Provenance): string {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${moduleKey(wasm)}.json`);
	const stored: Stored = { module: moduleKey(wasm), provenance: prov, record };
	writeFileSync(path, `${JSON.stringify(stored)}\n`);
	return path;
}

export type RungProvenance = Provenance & { wasmTools: string };

interface RungManifest {
	module: string;
	sets: string;
	provenance: RungProvenance;
	files: Record<string, { size: number; sha256: string }>;
}

export const setsKey = (sets: string) => sha256(sets);

const rungDir = (dir: string, wasm: Uint8Array, sets: string) => join(dir, `${moduleKey(wasm)}.${setsKey(sets)}.rungs`);

/** writes the rung files, then the manifest, so a save that stops half way leaves no manifest */
export function saveRungs(dir: string, wasm: Uint8Array, sets: string, files: Record<string, Uint8Array>, prov: RungProvenance): string {
	const at = rungDir(dir, wasm, sets);
	mkdirSync(at, { recursive: true });
	const manifest: RungManifest = { module: moduleKey(wasm), sets: setsKey(sets), provenance: prov, files: {} };
	for (const [name, bytes] of Object.entries(files)) {
		writeFileSync(join(at, name), bytes);
		manifest.files[name] = { size: bytes.length, sha256: sha256(bytes) };
	}
	writeFileSync(join(at, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
	return at;
}

/** the rung files when this module's planned sets were built under prov and every file is whole, else why not */
export function loadRungs(dir: string, wasm: Uint8Array, sets: string, prov: RungProvenance): { files: Record<string, Uint8Array> } | { refused: string } {
	const at = rungDir(dir, wasm, sets);
	if (!existsSync(join(at, 'manifest.json'))) return { refused: 'none for these sets' };
	let m: RungManifest;
	try {
		m = JSON.parse(readFileSync(join(at, 'manifest.json'), 'utf8')) as RungManifest;
	} catch {
		return { refused: 'unreadable' };
	}
	if (m.module !== moduleKey(wasm)) return { refused: 'module hash' };
	if (m.sets !== setsKey(sets)) return { refused: 'sets hash' };
	for (const k of Object.keys(prov) as (keyof RungProvenance)[]) if (m.provenance?.[k] !== prov[k]) return { refused: k };
	const files: Record<string, Uint8Array> = {};
	for (const [name, want] of Object.entries(m.files ?? {})) {
		if (!existsSync(join(at, name))) return { refused: `${name} missing` };
		const bytes = readFileSync(join(at, name));
		if (bytes.length !== want.size) return { refused: `${name} size` };
		if (sha256(bytes) !== want.sha256) return { refused: `${name} hash` };
		files[name] = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length);
	}
	if (!Object.keys(files).length) return { refused: 'no files' };
	return { files };
}

/** the cached rungs, or the result of prepare (saved for next time) when the cache refuses them */
export function rungsOrPrepare(
	dir: string,
	wasm: Uint8Array,
	sets: string,
	prov: RungProvenance,
	prepare: () => Record<string, Uint8Array>
): { files: Record<string, Uint8Array>; source: 'cache' | 'prepare'; refused?: string } {
	const got = loadRungs(dir, wasm, sets, prov);
	if ('files' in got) return { files: got.files, source: 'cache' };
	const files = prepare();
	saveRungs(dir, wasm, sets, files, prov);
	return { files, source: 'prepare', refused: got.refused };
}

/** the record when one for this module was made under prov, else the first key that differs */
export function load(dir: string, wasm: Uint8Array, prov: Provenance): { record: ProfileRecord } | { refused: string } {
	const path = join(dir, `${moduleKey(wasm)}.json`);
	if (!existsSync(path)) return { refused: 'none for this module' };
	let stored: Stored;
	try {
		stored = JSON.parse(readFileSync(path, 'utf8')) as Stored;
	} catch {
		return { refused: 'unreadable' };
	}
	if (stored.module !== moduleKey(wasm)) return { refused: 'module hash' };
	for (const k of Object.keys(prov) as (keyof Provenance)[]) if (stored.provenance?.[k] !== prov[k]) return { refused: k };
	return { record: stored.record };
}
