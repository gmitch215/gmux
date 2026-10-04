import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROUTER_BUILD, routerModules } from '../../scripts/wasm/router-modules.ts';
import { statxHash } from '../../src/worker/machine/machine.ts';
import {
	MISS,
	ROUTE_HOOK,
	ROUTE_KERNEL,
	ROUTE_WATCH,
	ROUTE_WRITES,
	STATX_BUCKETS,
	STATX_GUARDS,
	STATX_PATH_MAX,
	STATX_SETS,
	SYNC_CALLS,
	SYS_STATX,
	StatxTable,
	WRITE_CALLS,
	statxBucket
} from '../../src/worker/machine/router.ts';

const modules = routerModules();
const O_DSYNC = 0o10000;
const SYS_OPENAT = 56;

describe('syscall router', () => {
	it('places nothing in the task memory it imports', () => {
		const bytes = readFileSync(join(ROUTER_BUILD, 'router.wasm'));
		const ids: number[] = [];
		for (let at = 8; at < bytes.length;) {
			ids.push(bytes[at++]!);
			let size = 0;
			for (let shift = 0; ; shift += 7) {
				const b = bytes[at++]!;
				size |= (b & 0x7f) << shift;
				if (b < 0x80) break;
			}
			at += size;
		}
		// 11 is the data section, 12 its count
		expect(ids).not.toContain(11);
		expect(ids).not.toContain(12);
	});

	// where a call goes, from the rules router.ts documents
	const goes = (route: number, nr: number, flags: number, arity: number) => {
		if (route === ROUTE_KERNEL) return 'k';
		const dsync = arity >= 3 && nr === SYS_OPENAT && (flags & O_DSYNC) !== 0;
		const hook =
			route === ROUTE_HOOK ||
			SYNC_CALLS.includes(nr) ||
			dsync ||
			(route === ROUTE_WRITES && WRITE_CALLS.includes(nr));
		return hook ? 'h' : 'k';
	};

	it('sends every syscall number, at every arity and route, where the lists say', () => {
		for (const route of [ROUTE_WATCH, ROUTE_KERNEL, ROUTE_HOOK, ROUTE_WRITES]) {
			const seen: string[] = [];
			const global = new WebAssembly.Global({ value: 'i32', mutable: true }, route);
			const k: Record<string, unknown> = {};
			const h: Record<string, unknown> = {};
			for (let n = 0; n <= 6; n++) {
				k[n] = (...a: number[]) => (seen.push(`k${n}:${a.join(',')}`), 100 + n);
				h[n] = (...a: number[]) => (seen.push(`h${n}:${a.join(',')}`), 200 + n);
			}
			const s = new WebAssembly.Instance(modules.route, {
				k: k as WebAssembly.ModuleImports,
				h: h as WebAssembly.ModuleImports,
				c: { 5: () => MISS },
				env: {
					memory: new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }),
					route: global,
					cache: new WebAssembly.Global({ value: 'i32', mutable: false }, 0)
				}
			}).exports as Record<string, (...a: number[]) => number>;
			for (let n = 0; n <= 6; n++)
				for (let nr = 0; nr < 420; nr++)
					for (const flags of [0, O_DSYNC, 0o4010001, O_DSYNC | 0o100]) {
						const args = [1, 2, nr, 3, 4, flags, 5, 6, 7].slice(0, 3 + n);
						seen.length = 0;
						const result = s[`s${n}`]!(...args);
						const to = goes(route, nr, flags, n);
						expect(seen, `route ${route} s${n} nr ${nr} flags ${flags}`).toEqual([
							`${to}${n}:${args.join(',')}`
						]);
						expect(result).toBe((to === 'k' ? 100 : 200) + n);
					}
		}
	});

	it('imports its memory and declares none of its own', () => {
		expect(
			WebAssembly.Module.imports(modules.route).filter((i) => i.kind === 'memory')
		).toEqual([{ module: 'env', name: 'memory', kind: 'memory' }]);
		expect(WebAssembly.Module.exports(modules.route).map((e) => e.name)).toEqual(
			[0, 1, 2, 3, 4, 5, 6].map((n) => `s${n}`)
		);
	});
});

describe('statx hit path', () => {
	const PATH = 0x100;
	const BUF = 0x400;
	const answer = new Uint8Array(256).map((_, i) => i ^ 0x5a);

	const rig = (verify = false) => {
		const memory = new WebAssembly.Memory({ initial: 1, maximum: 4, shared: true });
		const table = new StatxTable(verify);
		// counters by index, -1 for the mount and chroot count; ats counts the kernel's reads of them
		const kernel = {
			view: 0x1234,
			gen: 7,
			views: 0,
			gens: 0,
			ats: 0,
			counters: new Map<number, number>()
		};
		const exports = new WebAssembly.Instance(modules.statx, {
			env: { user: memory, table: table.memory },
			kernel: {
				view: () => (kernel.views++, kernel.view),
				gen: () => (kernel.gens++, kernel.gen),
				at: (i: number) => (kernel.ats++, kernel.counters.get(i) ?? 0)
			}
		}).exports as { hit: (...a: number[]) => number; key: (...a: number[]) => bigint };
		const mem = new Uint8Array(memory.buffer);
		const put = (at: number, text: string) => {
			mem.set(new TextEncoder().encode(text), at);
			mem[at + text.length] = 0;
		};
		const fill = (path: string, over: Partial<Parameters<StatxTable['set']>[1]> = {}) => {
			put(PATH, path);
			const bytes = mem.slice(PATH, PATH + path.length);
			const hash = statxHash(mem, PATH, kernel.view, 0, 0x7ff)!;
			table.set(hash, {
				view: kernel.view,
				flags: 0,
				mask: 0x7ff,
				path: bytes,
				gen: kernel.gen,
				ret: 0,
				bytes: answer,
				...over
			});
			return hash;
		};
		const hit = (buf = BUF, flags = 0, mask = 0x7ff, path = PATH) =>
			exports.hit(0, 0, SYS_STATX, -100, path, flags, mask, buf);
		return { memory, mem, table, kernel, exports, put, fill, hit };
	};

	it('hashes as machine.ts does, and refuses a relative or unterminated path', () => {
		const { mem, put, exports, memory } = rig();
		for (const [path, view, flags, mask] of [
			['/', 1, 0, 0],
			['/bin/busybox', 0xdead0000 | 0, 0x100, 0x7ff],
			['/a/b/c/d/e', 5, -1, -1],
			['/' + 'x'.repeat(4094), 9, 0, 0x7ff]
		] as const) {
			put(PATH, path);
			const key = exports.key(PATH, view, flags, mask);
			expect(Number(BigInt.asUintN(32, key))).toBe(statxHash(mem, PATH, view, flags, mask));
			expect(Number(key >> 32n)).toBe(path.length);
		}
		put(PATH, 'relative');
		expect(exports.key(PATH, 1, 0, 0)).toBe(-1n);
		// 4096 bytes without a NUL, and a path running to the end of the memory
		mem.fill(0x2f, PATH, PATH + 4097);
		expect(exports.key(PATH, 1, 0, 0)).toBe(-1n);
		expect(statxHash(mem, PATH, 1, 0, 0)).toBeNull();
		const end = memory.buffer.byteLength;
		mem.fill(0x2f, end - 8, end);
		expect(exports.key(end - 8, 1, 0, 0)).toBe(-1n);
		expect(exports.key(end, 1, 0, 0)).toBe(-1n);
		expect(exports.key(0xfffffff0, 1, 0, 0)).toBe(-1n);
	});

	it('answers a held path with its bytes and return value, and counts it', () => {
		const { mem, fill, hit, table } = rig();
		fill('/bin/ls');
		expect(hit()).toBe(0);
		expect(mem.slice(BUF, BUF + 256)).toEqual(answer);
		expect(mem[BUF + 256]).toBe(0);
		expect(table.hits).toBe(1);
		expect(table.misses).toBe(0);
	});

	it('answers a negative errno with no bytes to copy', () => {
		const { mem, fill, hit } = rig();
		fill('/nope', { ret: -2, bytes: null });
		mem.fill(0xee, BUF, BUF + 8);
		expect(hit()).toBe(-2);
		expect(mem[BUF]).toBe(0xee);
	});

	it('misses on a stale generation, another view, other flags or mask, or another path', () => {
		const { kernel, fill, hit, table, put } = rig();
		fill('/bin/ls');
		kernel.gen = 8;
		expect(hit()).toBe(MISS);
		kernel.gen = 7;
		expect(hit(BUF, 1)).toBe(MISS);
		expect(hit(BUF, 0, 0x7fe)).toBe(MISS);
		kernel.view = 0x4321;
		expect(hit()).toBe(MISS);
		kernel.view = 0;
		expect(hit()).toBe(MISS);
		kernel.view = 0x1234;
		put(PATH, '/bin/lt');
		expect(hit()).toBe(MISS);
		put(PATH, '/bin/ls');
		expect(hit()).toBe(0);
		expect(table.misses).toBe(6);
		expect(table.hits).toBe(1);
	});

	it('compares the path itself when a slot holds another path under the same hash', () => {
		// the stored path goes under the asked path's hash, as a collision would leave it
		const forced = (stored: string, asked: string) => {
			const s = rig();
			s.put(PATH, asked);
			const hash = statxHash(s.mem, PATH, s.kernel.view, 0, 0x7ff)!;
			s.table.set(hash, {
				view: s.kernel.view,
				flags: 0,
				mask: 0x7ff,
				path: new TextEncoder().encode(stored),
				gen: s.kernel.gen,
				ret: 0,
				bytes: null
			});
			return s.hit();
		};
		expect(forced('/bin/ls', '/bin/ls')).toBe(0);
		// a prefix, an extension and the same length with one byte off
		expect(forced('/bin', '/bin/ls')).toBe(MISS);
		expect(forced('/bin/ls', '/bin')).toBe(MISS);
		expect(forced('/bin/lt', '/bin/ls')).toBe(MISS);
	});

	it('leaves a buffer the memory does not hold to the kernel', () => {
		const { memory, fill, hit } = rig();
		fill('/bin/ls');
		const size = memory.buffer.byteLength;
		expect(hit(size - 255)).toBe(MISS);
		expect(hit(0xffffff80)).toBe(MISS);
		expect(hit(size - 256)).toBe(0);
	});

	it('always misses in verify mode and asks the kernel nothing', () => {
		const { fill, hit, table, kernel } = rig(true);
		fill('/bin/ls');
		expect(hit()).toBe(MISS);
		expect(table.hits).toBe(0);
		expect(table.misses).toBe(1);
		expect(kernel.views).toBe(0);
	});

	it('asks the kernel for the generation only when a slot matches', () => {
		const { fill, hit, kernel, put } = rig();
		put(PATH, '/never');
		hit();
		expect(kernel.gens).toBe(0);
		fill('/bin/ls');
		hit();
		expect(kernel.views).toBe(2);
		expect(kernel.gens).toBe(1);
		expect(kernel.ats).toBe(0);
	});

	describe('guarded by inode counters', () => {
		const guarded = (guards: [number, number][], moves = 2) => {
			const s = rig();
			s.kernel.counters.set(-1, moves);
			for (const [index, value] of guards) s.kernel.counters.set(index, value);
			s.fill('/usr/lib/x', { gen: moves, guards });
			return s;
		};

		it('holds while the mount count and every listed counter are what they were', () => {
			const s = guarded([
				[5, 10],
				[4000, 0xfffffffe],
				[0, 0]
			]);
			expect(s.hit()).toBe(0);
			expect(s.mem.slice(BUF, BUF + 256)).toEqual(answer);
			// the kernel's generation, which a write anywhere moves, is not asked
			s.kernel.gen = 99;
			expect(s.hit()).toBe(0);
			expect(s.kernel.gens).toBe(0);
			expect(s.kernel.ats).toBe(8);
			expect(s.table.hits).toBe(2);
		});

		it('misses when one counter moved, when the mount count moved, or on a reused counter', () => {
			const s = guarded([
				[5, 10],
				[6, 11],
				[7, 12]
			]);
			for (const index of [5, 6, 7]) {
				s.kernel.counters.set(index, s.kernel.counters.get(index)! + 1);
				expect(s.hit(), `counter ${index}`).toBe(MISS);
				s.kernel.counters.set(index, s.kernel.counters.get(index)! - 1);
			}
			expect(s.hit()).toBe(0);
			s.kernel.counters.set(-1, 3);
			expect(s.hit()).toBe(MISS);
			expect(s.table.misses).toBe(4);
		});

		it('reads only as many counters as the slot lists', () => {
			const s = guarded([[9, 1]]);
			s.hit();
			expect(s.kernel.ats).toBe(2);
			const full = guarded(Array.from({ length: STATX_GUARDS }, (_, i) => [i + 100, i]));
			full.hit();
			expect(full.kernel.ats).toBe(STATX_GUARDS + 1);
		});

		it('is replaced by a refill held on the generation, which is then the one asked', () => {
			const s = guarded([[5, 10]]);
			s.fill('/usr/lib/x', { gen: 7 });
			expect(s.table.get(statxHash(s.mem, PATH, s.kernel.view, 0, 0x7ff)!)!.guards).toEqual(
				[]
			);
			expect(s.hit()).toBe(0);
			expect(s.kernel.gens).toBe(1);
		});
	});
});

describe('statx table', () => {
	const entry = (path: string, ret = 0) => ({
		view: 0xfffffff0,
		flags: -5,
		mask: 0x7ff,
		path: new TextEncoder().encode(path),
		gen: 0xffffffff,
		ret,
		bytes: null
	});

	it('round-trips an answer with its unsigned and signed fields', () => {
		const table = new StatxTable(false);
		expect(
			table.set(0xfedcba98, { ...entry('/a/b', -20), bytes: new Uint8Array(256).fill(9) })
		).toBe(true);
		const held = table.get(0xfedcba98)!;
		expect(held).toMatchObject({
			view: 0xfffffff0,
			flags: -5,
			mask: 0x7ff,
			gen: 0xffffffff,
			ret: -20
		});
		expect(new TextDecoder().decode(held.path)).toBe('/a/b');
		expect(held.bytes).toEqual(new Uint8Array(256).fill(9));
		expect(table.get(0xfedcba99)).toBeUndefined();
	});

	it('keeps two keys of a set, then replaces the one of the older generation', () => {
		const table = new StatxTable(false);
		const [a, b, c] = [5, 5 + STATX_SETS, 5 + 2 * STATX_SETS];
		table.set(a, { ...entry('/one'), gen: 4 });
		table.set(b, { ...entry('/two'), gen: 3 });
		expect(new TextDecoder().decode(table.get(a)!.path)).toBe('/one');
		expect(new TextDecoder().decode(table.get(b)!.path)).toBe('/two');
		table.set(c, { ...entry('/three'), gen: 5 });
		expect(table.get(b)).toBeUndefined();
		expect(table.get(a)).toBeDefined();
		expect(new TextDecoder().decode(table.get(c)!.path)).toBe('/three');
	});

	it('replaces a key in its own slot', () => {
		const table = new StatxTable(false);
		table.set(7, { ...entry('/one'), gen: 1 });
		table.set(7 + STATX_SETS, { ...entry('/two'), gen: 1 });
		table.set(7, { ...entry('/uno'), gen: 2, ret: -2 });
		expect(new TextDecoder().decode(table.get(7)!.path)).toBe('/uno');
		expect(table.get(7)!.ret).toBe(-2);
		expect(new TextDecoder().decode(table.get(7 + STATX_SETS)!.path)).toBe('/two');
	});

	it('holds a path of the longest length and refuses a longer one', () => {
		const table = new StatxTable(false);
		expect(table.set(1, entry('/' + 'p'.repeat(STATX_PATH_MAX - 1)))).toBe(true);
		expect(table.get(1)!.path.length).toBe(STATX_PATH_MAX);
		expect(table.set(2, entry('/' + 'p'.repeat(STATX_PATH_MAX)))).toBe(false);
		expect(table.get(2)).toBeUndefined();
	});

	it('round-trips the counters an answer holds on, and refuses more than it has room for', () => {
		const table = new StatxTable(false);
		const guards: [number, number][] = Array.from({ length: STATX_GUARDS }, (_, i) => [
			STATX_BUCKETS - 1 - i,
			0xfffffff0 + i
		]);
		expect(table.set(3, { ...entry('/usr/lib/x'), gen: 12, guards })).toBe(true);
		expect(table.get(3)).toMatchObject({ gen: 12, guards });
		expect(new TextDecoder().decode(table.get(3)!.path)).toBe('/usr/lib/x');
		// a replacement with none leaves none behind
		table.set(3, entry('/usr/lib/x'));
		expect(table.get(3)!.guards).toEqual([]);
		expect(table.set(4, { ...entry('/y'), guards: [...guards, [0, 0]] })).toBe(false);
	});

	it('numbers the inode counters as the kernel does', () => {
		// (u32)ino * 0x9e3779b1 >> 20 in wasm_fs_bucket (kernel patch 0029)
		expect(statxBucket(0)).toBe(0);
		expect(statxBucket(1)).toBe(0x9e3);
		expect(statxBucket(2)).toBe(0x3c6);
		expect(statxBucket(0xffffffff)).toBe(0x61c);
		for (const ino of [3, 1000, 123456789, 0x80000000]) {
			expect(statxBucket(ino)).toBeGreaterThanOrEqual(0);
			expect(statxBucket(ino)).toBeLessThan(STATX_BUCKETS);
		}
	});

	it('keeps its counters in the memory the hit path writes', () => {
		const table = new StatxTable(false);
		table.hits = 0xffffffff;
		table.misses = 3;
		expect(new Uint32Array(table.memory.buffer, 0, 3)).toEqual(
			new Uint32Array([0xffffffff, 3, 0])
		);
	});
});
