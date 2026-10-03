import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
	hashFiles,
	load,
	loadRungs,
	moduleKey,
	rungsOrPrepare,
	save,
	saveRungs,
	setsKey,
	type ProfileRecord,
	type Provenance,
	type RungProvenance
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

describe('rung cache', () => {
	const rprov: RungProvenance = { ...prov, wasmTools: 'wasm-tools 1.0.0' };
	const sets = '{"hottest@0.1":["f"]}';
	const files = (): Record<string, Uint8Array> => ({
		'rungs.json': new TextEncoder().encode('{"rungs":[]}'),
		'rung1.interp.wasm': new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 9]),
		'rung1.native.wasm': new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 7, 7])
	});
	const saved = () => {
		const d = dir();
		return { d, at: saveRungs(d, wasm, sets, files(), rprov) };
	};
	const manifestOf = (at: string) => join(at, 'manifest.json');
	const edit = (at: string, from: string | RegExp, to: string) =>
		writeFileSync(manifestOf(at), readFileSync(manifestOf(at), 'utf8').replace(from, to));

	it('round-trips the files under the same provenance and sets', () => {
		const { d } = saved();
		expect(load_(d)).toEqual({ files: files() });
	});

	const load_ = (d: string, p = rprov, s = sets, w = wasm) => loadRungs(d, w, s, p);

	it('refuses another set, another module and an empty cache', () => {
		const { d } = saved();
		expect(load_(d, rprov, '{"hottest@0.5":["g"]}')).toEqual({
			refused: 'none for these sets'
		});
		expect(load_(d, rprov, sets, new Uint8Array([...wasm, 0]))).toEqual({
			refused: 'none for these sets'
		});
		expect(load_(dir())).toEqual({ refused: 'none for these sets' });
	});

	it.each(Object.keys(rprov) as (keyof RungProvenance)[])('refuses when %s changes', (key) => {
		const { d } = saved();
		const other = { ...rprov, [key]: typeof rprov[key] === 'number' ? 2 : `${rprov[key]}x` };
		expect(load_(d, other)).toEqual({ refused: key });
	});

	it('refuses an unreadable manifest', () => {
		const { d, at } = saved();
		writeFileSync(manifestOf(at), '{');
		expect(load_(d)).toEqual({ refused: 'unreadable' });
	});

	it('refuses a manifest stored under another module or sets hash', () => {
		const a = saved();
		edit(a.at, moduleKey(wasm), 'f'.repeat(64));
		expect(load_(a.d)).toEqual({ refused: 'module hash' });
		const b = saved();
		edit(b.at, setsKey(sets), 'f'.repeat(64));
		expect(load_(b.d)).toEqual({ refused: 'sets hash' });
	});

	it('refuses a missing file, a truncated file and a changed file of the same size', () => {
		const a = saved();
		writeFileSync(join(a.at, 'rung1.native.wasm'), new Uint8Array([0, 97]));
		expect(load_(a.d)).toEqual({ refused: 'rung1.native.wasm size' });
		const b = saved();
		writeFileSync(
			join(b.at, 'rung1.interp.wasm'),
			new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 8])
		);
		expect(load_(b.d)).toEqual({ refused: 'rung1.interp.wasm hash' });
		const c = saved();
		rmSync(join(c.at, 'rungs.json'));
		expect(load_(c.d)).toEqual({ refused: 'rungs.json missing' });
	});

	it('refuses a manifest that lists no files', () => {
		const d = dir();
		saveRungs(d, wasm, sets, {}, rprov);
		expect(load_(d)).toEqual({ refused: 'no files' });
	});

	it('serves a hit without calling prepare', () => {
		const { d } = saved();
		const prepare = vi.fn(files);
		const got = rungsOrPrepare(d, wasm, sets, rprov, prepare);
		expect(got).toEqual({ files: files(), source: 'cache' });
		expect(prepare).not.toHaveBeenCalled();
	});

	const refusals: [string, (d: string, at: string) => void, string][] = [
		['no cache', (_d, at) => rmSync(at, { recursive: true }), 'none for these sets'],
		[
			'a manifest that cannot be read',
			(_d, at) => writeFileSync(manifestOf(at), '{'),
			'unreadable'
		],
		[
			'another module hash',
			(_d, at) => edit(at, moduleKey(wasm), 'f'.repeat(64)),
			'module hash'
		],
		['another sets hash', (_d, at) => edit(at, setsKey(sets), 'f'.repeat(64)), 'sets hash'],
		[
			'another wasm-tools',
			(_d, at) => edit(at, 'wasm-tools 1.0.0', 'wasm-tools 2.0.0'),
			'wasmTools'
		],
		['another burrow', (_d, at) => edit(at, '1.2.3', '1.2.4'), 'burrow'],
		[
			'a truncated file',
			(_d, at) => writeFileSync(join(at, 'rung1.native.wasm'), new Uint8Array([0])),
			'rung1.native.wasm size'
		],
		[
			'a corrupted file',
			(_d, at) => writeFileSync(join(at, 'rung1.interp.wasm'), new Uint8Array(9)),
			'rung1.interp.wasm hash'
		],
		[
			'a missing file',
			(_d, at) => rmSync(join(at, 'rung1.interp.wasm')),
			'rung1.interp.wasm missing'
		]
	];
	it.each(refusals)(
		'falls back to prepare on %s, then serves the rebuilt files',
		(_name, damage, why) => {
			const { d, at } = saved();
			damage(d, at);
			const rebuilt = { ...files(), 'rung1.interp.wasm': new Uint8Array([1, 2, 3]) };
			const prepare = vi.fn(() => rebuilt);
			const got = rungsOrPrepare(d, wasm, sets, rprov, prepare);
			expect(got).toEqual({ files: rebuilt, source: 'prepare', refused: why });
			expect(prepare).toHaveBeenCalledTimes(1);
			expect(rungsOrPrepare(d, wasm, sets, rprov, prepare)).toEqual({
				files: rebuilt,
				source: 'cache'
			});
			expect(prepare).toHaveBeenCalledTimes(1);
		}
	);
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
