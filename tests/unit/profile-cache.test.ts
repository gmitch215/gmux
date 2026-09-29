import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	hashFiles,
	load,
	moduleKey,
	save,
	type ProfileRecord,
	type Provenance
} from '../../experiments/profile-cache/scripts/cache.ts';

const prov: Provenance = {
	format: 1,
	burrow: '1.2.3',
	wasm3: 'abc123',
	burrowTools: 'b'.repeat(64),
	tools: 't'.repeat(64),
	params: '292:0.1'
};
const record: ProfileRecord = {
	graph: '{"g":1}',
	ends: '{"e":1}',
	plan: '{"p":1}',
	sets: '{"s":1}',
	catalog: '[]'
};
const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const dir = () => mkdtempSync(join(tmpdir(), 'profile-cache-'));

describe('profile cache', () => {
	it('round-trips a record under the same provenance', () => {
		const d = dir();
		save(d, wasm, record, prov);
		expect(load(d, wasm, prov)).toEqual({ record });
	});

	it('refuses a module it has not seen, and one whose bytes changed', () => {
		const d = dir();
		expect(load(d, wasm, prov)).toEqual({ refused: 'none for this module' });
		save(d, wasm, record, prov);
		expect(load(d, new Uint8Array([...wasm, 0]), prov)).toEqual({
			refused: 'none for this module'
		});
		expect(moduleKey(wasm)).toHaveLength(64);
	});

	it.each(Object.keys(prov) as (keyof Provenance)[])('refuses when %s changes', (key) => {
		const d = dir();
		save(d, wasm, record, prov);
		const other = { ...prov, [key]: typeof prov[key] === 'number' ? 2 : `${prov[key]}x` };
		expect(load(d, wasm, other)).toEqual({ refused: key });
	});

	it('refuses an unreadable file', () => {
		const d = dir();
		writeFileSync(join(d, `${moduleKey(wasm)}.json`), '{');
		expect(load(d, wasm, prov)).toEqual({ refused: 'unreadable' });
	});

	it('refuses a file stored under another module hash', () => {
		const d = dir();
		const path = save(d, wasm, record, prov);
		writeFileSync(path, readFileSync(path, 'utf8').replace(moduleKey(wasm), 'f'.repeat(64)));
		expect(load(d, wasm, prov)).toEqual({ refused: 'module hash' });
	});

	it('hashes file contents and names, independent of argument order', () => {
		const d = dir();
		writeFileSync(join(d, 'a'), '1');
		writeFileSync(join(d, 'b'), '2');
		const h = hashFiles([join(d, 'a'), join(d, 'b')]);
		expect(hashFiles([join(d, 'b'), join(d, 'a')])).toBe(h);
		writeFileSync(join(d, 'b'), '3');
		expect(hashFiles([join(d, 'a'), join(d, 'b')])).not.toBe(h);
	});
});

// burrow's own key inputs, driven through its provenance() over a copy of its tree
const burrow = process.env.BURROW_ROOT;
describe.skipIf(!burrow)('burrow provenance as the cache key', () => {
	const inputs = [
		'tools/interp/wasm3-fuse-hook.patch',
		'tools/interp/shim.c',
		'tools/interp/fuse-runtime.inc',
		'tools/interp/gen-fuse.mjs',
		'tools/interp/profile.inc',
		'tools/interp/trace.ts',
		'tools/seq-mine.ts',
		'tools/build-interp.sh',
		'package.json'
	];
	it.each(inputs)('refuses when %s changes', async (file) => {
		const { provenance } = (await import(join(burrow!, 'tools/interp/artifact.ts'))) as {
			provenance: (root: string) => { burrow: string; wasm3: string; tools: string };
		};
		const root = mkdtempSync(join(tmpdir(), 'burrow-tree-'));
		mkdirSync(join(root, 'tools'), { recursive: true });
		cpSync(join(burrow!, 'tools/interp'), join(root, 'tools/interp'), { recursive: true });
		for (const f of ['tools/seq-mine.ts', 'tools/build-interp.sh', 'package.json'])
			cpSync(join(burrow!, f), join(root, f));
		const of = (p: { burrow: string; wasm3: string; tools: string }): Provenance => ({
			...prov,
			burrow: p.burrow,
			wasm3: p.wasm3,
			burrowTools: p.tools
		});
		const d = dir();
		save(d, wasm, record, of(provenance(root)));
		expect('record' in load(d, wasm, of(provenance(root)))).toBe(true);
		const at = join(root, file);
		writeFileSync(
			at,
			file === 'package.json'
				? readFileSync(at, 'utf8').replace(
						/"version": "[^"]*"/,
						'"version": "0.0.0-changed"'
					)
				: `${readFileSync(at, 'utf8')}\n// changed\n`
		);
		expect('refused' in load(d, wasm, of(provenance(root)))).toBe(true);
	});
});
