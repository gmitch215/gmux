import binaryen from 'binaryen';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { Machine } from '../../src/worker/machine/machine.ts';
import { HOST_ONLY, hostOnly, leaks, SURFACE, watch } from '../c/authority.ts';

// SECURITY.md's authority domains: guest root reaches no binding, secret, storage or publication
// authority. tests/c/authority.c is the probe in a real machine; these hold the host's side
vi.mock('../../src/site-do.ts', () => ({ MachineDO: class {} }));

const fixture = (name: string, features: number) => {
	const m = binaryen.parseText(
		readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')
	);
	m.setFeatures(features);
	const bytes = m.emitBinary();
	m.dispose();
	return new WebAssembly.Module(bytes);
};
const F = binaryen.Features;

describe('the host side of guest root', () => {
	it('finds a planted value in a guest memory, and nothing it never put there', async () => {
		const values = await hostOnly();
		expect(values).toHaveLength(4);
		expect(values.slice(0, 2).every((v) => v.startsWith(HOST_ONLY))).toBe(true);
		expect(process.env.GMUX_HOST_SECRET).toBe(values[1]);
		const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
		new TextEncoder().encodeInto(`..${values[2]}..`, new Uint8Array(memory.buffer, 100));
		expect(leaks(values, [new ArrayBuffer(64), memory.buffer])).toEqual([
			'value #2 at memory 1 offset 102'
		]);
	});

	it('takes the kernel drivers and the syscall surface, and nothing a binding would be', () => {
		for (const name of [
			'env.memory',
			'env.wasm_driver_hvc_put',
			'env.__wasm_syscall_6',
			'env.__gmux_fuel',
			'gmux.table'
		])
			expect(name).toMatch(SURFACE);
		for (const name of [
			'env.fetch',
			'env.MACHINE',
			'env.ASSETS',
			'env.__gmux_secret',
			'cloudflare.env',
			'env.wasm'
		])
			expect(name).not.toMatch(SURFACE);
	});

	it('gives a machine, kernel and program, only surface imports and none of the host-only values', async () => {
		const values = await hostOnly();
		const seen = watch();
		let output = '';
		let machine: Machine;
		try {
			machine = new Machine({
				vmlinux: fixture('toy-kernel.wat', F.Atomics | F.MutableGlobals | F.BulkMemory),
				initrd: new Uint8Array(16),
				cmdline: 'toy',
				registry: new Map([
					['U', fixture('toy-user.wat', F.Atomics | F.MutableGlobals | F.MultiMemory)]
				]),
				maximumPages: 64,
				sha256: (bytes) => String.fromCharCode(bytes[0] ?? 0),
				now: () => 0n,
				write: (text) => (output += text)
			});
			const run = (until: () => boolean) => machine.run(until, async () => {}, 20_000);
			await run(() => output.includes('parent ok'));
			machine.type('u');
			await run(() => output.includes('handled'));
		} finally {
			seen.stop();
		}
		expect(output).toContain('handled');
		const buffers = [...new Set([machine!.memory, ...seen.memories])].map((m) => m.buffer);
		expect(leaks(['parent ok'], buffers)).not.toEqual([]);
		expect(leaks(values, buffers)).toEqual([]);
		expect([...seen.imports].filter((i) => !SURFACE.test(i))).toEqual([]);
		expect([...seen.imports]).toContain('env.wasm_driver_hvc_put');
		// a program's syscalls are bound to the kernel's exports, not to the host
		expect([...seen.imports].some((i) => i.startsWith('env.__wasm_syscall_'))).toBe(false);
	});

	it("counts an import the host supplies, not one bound to another instance's export", () => {
		// (module (func (export "f"))) and (module (import "env" "f" (func)) (import "env" "g" (func)))
		const head = [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1, 4, 1, 0x60, 0, 0];
		const lib = [...head, 3, 2, 1, 0, 7, 5, 1, 1, 0x66, 0, 0, 10, 4, 1, 2, 0, 0x0b];
		const env = (name: number) => [3, 0x65, 0x6e, 0x76, 1, name, 0, 0];
		const user = [...head, 2, 17, 2, ...env(0x66), ...env(0x67)];
		const seen = watch();
		try {
			const a = new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(lib)));
			new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(user)), {
				env: { f: a.exports.f!, g: () => {} }
			});
		} finally {
			seen.stop();
		}
		expect([...seen.imports]).toEqual(['env.g']);
	});
});

describe('the deployment', () => {
	it('binds only the machine and its static assets, with no variable or secret', () => {
		const config = JSON.parse(
			readFileSync(new URL('../../wrangler.jsonc', import.meta.url), 'utf8')
		);
		expect(Object.keys(config).sort()).toEqual(
			[
				'$schema',
				'assets',
				'compatibility_date',
				'compatibility_flags',
				'durable_objects',
				'main',
				'migrations',
				'minify',
				'name',
				'rules'
			].sort()
		);
		expect(config.durable_objects.bindings).toEqual([
			{ name: 'MACHINE', class_name: 'MachineDO' }
		]);
		expect(config.assets.binding).toBe('ASSETS');
		const env = readFileSync(new URL('../../src/site-do.ts', import.meta.url), 'utf8').match(
			/interface Env \{([^}]*)\}/
		)![1]!;
		expect(env.match(/^\s*\w+/gm)!.map((s) => s.trim())).toEqual(['MACHINE', 'ASSETS']);
	});

	it('publishes nothing a guest makes: every path but /_gmux/ is the no-site answer', async () => {
		const { default: site } = await import('../../src/site.ts');
		const calls: string[] = [];
		const env = {
			ASSETS: {
				fetch: (u: URL) => (
					calls.push(`assets ${new URL(u).pathname}`),
					new Response('term')
				)
			},
			MACHINE: {
				idFromName: (n: string) => n,
				get: () => ({
					fetch: (r: Request) => (
						calls.push(`machine ${new URL(r.url).pathname}`),
						new Response('ok')
					)
				})
			}
		} as never;
		for (const path of ['/', '/index.html', '/api/v4/accounts', '/_gmuxx', '/.well-known/x']) {
			const res = await site.fetch(new Request(`https://m.example${path}`), env, {} as never);
			expect([path, res.status]).toEqual([path, 503]);
		}
		expect(calls).toEqual([]);
		await site.fetch(new Request('https://m.example/_gmux/term'), env, {} as never);
		await site.fetch(new Request('https://m.example/_gmux/status'), env, {} as never);
		expect(calls).toEqual(['assets /_gmux/term/index.html', 'machine /_gmux/status']);
	});
});
