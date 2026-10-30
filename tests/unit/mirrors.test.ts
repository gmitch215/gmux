import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { drift, parseRefs, slug } from '../../scripts/sync-mirrors.ts';

const read = (file: string) => JSON.parse(readFileSync(`src/${file}`, 'utf8'));
const pin = (name: string, key: string) =>
	execFileSync(
		'node',
		['--no-warnings', '--experimental-strip-types', 'scripts/pin.ts', name, key],
		{
			encoding: 'utf8'
		}
	).trim();

describe('parseRefs', () => {
	it('reads ls-remote lines and skips peeled tags and blanks', () => {
		const text = 'a1\trefs/heads/wasm-7.0\nb2\trefs/tags/v1\nc3\trefs/tags/v1^{}\n\n';
		expect(parseRefs(text)).toEqual({ 'refs/heads/wasm-7.0': 'a1', 'refs/tags/v1': 'b2' });
	});
});

describe('drift', () => {
	it('splits new refs from moved ones and ignores refs only the mirror has', () => {
		const origin = { 'refs/heads/a': '1', 'refs/heads/b': '2', 'refs/heads/c': '3' };
		const mirror = { 'refs/heads/a': '1', 'refs/heads/b': '9', 'refs/heads/extra': '4' };
		expect(drift(origin, mirror)).toEqual({
			added: { 'refs/heads/c': '3' },
			moved: { 'refs/heads/b': '2' }
		});
	});

	it('finds nothing when the mirror matches', () => {
		const refs = { 'refs/heads/a': '1' };
		expect(drift(refs, refs)).toEqual({ added: {}, moved: {} });
	});
});

describe('slug', () => {
	it('turns a GitHub clone URL into owner/name', () => {
		expect(slug('https://github.com/gmitch215/linux.git')).toBe('gmitch215/linux');
	});
});

describe('src/mirrors.json', () => {
	const sources = read('sources.json');
	const mirrors: Record<string, string> = read('mirrors.json');

	it('names only pinned sources and a different repository from each one', () => {
		for (const [name, url] of Object.entries(mirrors)) {
			expect(sources[name]?.commit, name).toBeTypeOf('string');
			expect(url, name).not.toBe(sources[name].repo);
		}
	});

	it('is what pin.ts prints for repo, with the original under origin', () => {
		for (const [name, url] of Object.entries(mirrors)) {
			expect(pin(name, 'repo')).toBe(url);
			expect(pin(name, 'origin')).toBe(sources[name].repo);
		}
	});

	it('leaves a source with no mirror at its own repository', () => {
		expect(pin('musl', 'repo')).toBe(sources.musl.repo);
	});
});
