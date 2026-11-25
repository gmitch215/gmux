import { describe, expect, it } from 'vitest';
import {
	CMDLINE,
	siteCmdline,
	siteOptions,
	type SiteBuild
} from '../../src/worker/site-machine.ts';

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

	it('leaves instances made ahead off and does not share one instance among processes', () => {
		const options = siteOptions(build(), host);
		expect(options.prefillInstances ?? 0).toBe(0);
		expect(options.shareInstances ?? false).toBe(false);
	});

	it('keeps exec stub facts', () => {
		expect(siteOptions(build(), host).execCache).toBe(true);
	});

	it('registers lighttpd and starts it from the command line only when the build carries it', () => {
		const plain = siteOptions(build(), host);
		expect(plain.cmdline).toBe(CMDLINE);
		expect(plain.registry.size).toBe(2);
		const b = build({
			lighttpd: empty(),
			manifest: { busybox: 'bb', katybug: 'kb', lighttpd: 'lt' }
		});
		const options = siteOptions(b, host);
		expect(options.registry.get('lt')).toBe(b.lighttpd);
		expect(options.cmdline).toBe(`${CMDLINE} gmux.http=lighttpd`);
		expect(options.cmdline).toBe(siteCmdline(true));
		// the module without its hash, or the hash without its module, is no server
		expect(siteOptions(build({ lighttpd: empty() }), host).cmdline).toBe(CMDLINE);
		const named = build({ manifest: { busybox: 'bb', katybug: 'kb', lighttpd: 'lt' } });
		expect(siteOptions(named, host).registry.has('lt')).toBe(false);
	});

	it('registers the share build under the same hash when one is given, and keeps the guarded build', () => {
		const b = build({ busyboxShare: empty() });
		const options = siteOptions(b, host);
		expect(options.registry.get('bb')).toBe(b.busyboxShare);
		expect(options.guarded?.get('bb')).toBe(b.busyboxGuard);
	});
});
