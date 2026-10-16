import { describe, expect, it } from 'vitest';
import { siteOptions, type SiteBuild } from '../../src/worker/site-machine.ts';

const empty = () => new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));

const build = (extra: Partial<SiteBuild> = {}): SiteBuild => ({
	vmlinux: empty(),
	busybox: empty(),
	busyboxGuard: empty(),
	katybug: empty(),
	runtime: {} as SiteBuild['runtime'],
	initrd: new Uint8Array(),
	manifest: { busybox: 'bb', katybug: 'kb' },
	...extra
});

const host = { sha256: () => '', digest: undefined, write: () => {}, memory: undefined };

describe('siteOptions', () => {
	it('registers the asyncified BusyBox, the guarded build and katybug', () => {
		const b = build();
		const options = siteOptions(b, host);
		expect(options.registry.get('bb')).toBe(b.busybox);
		expect(options.registry.get('kb')).toBe(b.katybug);
		expect(options.guarded?.get('bb')).toBe(b.busyboxGuard);
		expect(options.asyncify).toBe(true);
	});

	it('registers the share build under the same hash when one is given, and keeps the guarded build', () => {
		const b = build({ busyboxShare: empty() });
		const options = siteOptions(b, host);
		expect(options.registry.get('bb')).toBe(b.busyboxShare);
		expect(options.guarded?.get('bb')).toBe(b.busyboxGuard);
	});
});
