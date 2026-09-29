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
