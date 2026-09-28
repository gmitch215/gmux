import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inputs } from '../../scripts/wasm/inputs.ts';

function tree(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), 'gmux-inputs-'));
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(join(root, path, '..'), { recursive: true });
		writeFileSync(join(root, path), text);
	}
	return root;
}

const base = {
	'src/sources.json': '{"linux":{"commit":"a"}}',
	'src/kernel/patches/0001-a.patch': 'one',
	'src/busybox/patches/0001-b.patch': 'two',
	'src/gmux/katybug/run.c': 'not a patch'
};

describe('inputs', () => {
	it('is the same for the same pins and patches, however the tree was written', () => {
		const reversed = Object.fromEntries(Object.entries(base).reverse());
		expect(inputs(tree(base))).toBe(inputs(tree(reversed)));
	});

	it('changes when a patch or a pin changes, and not for other sources or dotfiles', () => {
		const h = inputs(tree(base));
		expect(inputs(tree({ ...base, 'src/kernel/patches/0001-a.patch': 'uno' }))).not.toBe(h);
		expect(inputs(tree({ ...base, 'src/musl/patches/0001-c.patch': 'three' }))).not.toBe(h);
		expect(inputs(tree({ ...base, 'src/sources.json': '{"linux":{"commit":"b"}}' }))).not.toBe(
			h
		);
		expect(inputs(tree({ ...base, 'src/gmux/katybug/run.c': 'edited' }))).toBe(h);
		expect(inputs(tree({ ...base, 'src/kernel/patches/.DS_Store': 'x' }))).toBe(h);
	});
});
