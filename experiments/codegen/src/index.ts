import { DurableObject } from 'cloudflare:workers';
import { gunzipSync } from 'fflate';
import packGz from './pack.bin';
import phpBytes from './php.bin';
import wasm3Bytes from './wasm3.bin';
import workBytes from './work.bin';
import workBundled from './work.wasm';

interface Env {
	PROBE: DurableObjectNamespace<ProbeDO>;
	COMPILE_PHP?: string;
}

declare const __COMPILE_PHP__: boolean;
declare const __PACK_COPIES__: number;

// compressed packs: one gzip of vmlinux and busybox, decompressed and compiled N times at startup
const VMLINUX_BYTES = 3055425;
const pack: { copies: number; ok: boolean; error?: string; rawBytes?: number; modules: number } = {
	copies: __PACK_COPIES__,
	ok: true,
	modules: 0
};
try {
	for (let c = 0; c < __PACK_COPIES__; c++) {
		const raw = gunzipSync(new Uint8Array(packGz));
		pack.rawBytes = raw.byteLength;
		new WebAssembly.Module(raw.subarray(0, VMLINUX_BYTES));
		new WebAssembly.Module(raw.subarray(VMLINUX_BYTES));
		pack.modules += 2;
	}
} catch (error) {
	pack.ok = false;
	pack.error = String(error);
}

// top-level evaluation is the one window where the embedder allows codegen from bytes
const startup: Record<string, { ok: boolean; error?: string; exports?: number; bytes: number }> =
	{};
function compileAtStartup(name: string, bytes: ArrayBuffer) {
	try {
		const module = new WebAssembly.Module(bytes);
		startup[name] = {
			ok: true,
			exports: WebAssembly.Module.exports(module).length,
			bytes: bytes.byteLength
		};
		return module;
	} catch (error) {
		startup[name] = { ok: false, error: String(error), bytes: bytes.byteLength };
		return null;
	}
}
const wasm3 = compileAtStartup('wasm3', wasm3Bytes);
const php = __COMPILE_PHP__ ? compileAtStartup('php', phpBytes) : null;
const workStartup = compileAtStartup('work', workBytes);

function burn(module: WebAssembly.Module | null, iters: number) {
	if (!module) return null;
	const instance = new WebAssembly.Instance(module, { host: { yield: () => 0 } });
	const fn = instance.exports.burn as (n: number, x: number) => number;
	let x = 1;
	for (let done = 0; done < iters; done += 1e8) x = fn(Math.min(1e8, iters - done), x);
	return x;
}

function requestCompile(bytes: ArrayBuffer) {
	try {
		new WebAssembly.Module(bytes);
		return { ok: true };
	} catch (error) {
		return { ok: false, error: String(error) };
	}
}

function runWasm3() {
	if (!wasm3) return { ok: false, error: 'not compiled at startup' };
	const instance = new WebAssembly.Instance(wasm3, {
		env: { emscripten_notify_memory_growth: () => {} },
		burrow: { host_call: () => 1 }
	});
	const shim = instance.exports as any;
	shim._initialize();
	return {
		ok: shim.burrow_init(1024 * 1024, 0) === 0,
		memoryBytes: shim.memory.buffer.byteLength
	};
}

function report(where: string) {
	return {
		where,
		startup,
		instantiate: runWasm3(),
		requestCompileWasm3: requestCompile(wasm3Bytes)
	};
}

export class ProbeDO extends DurableObject<Env> {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.searchParams.has('mode')) {
			const iters = Number(url.searchParams.get('iters') ?? 1e8);
			const module = url.searchParams.get('mode') === 'startup' ? workStartup : workBundled;
			return Response.json({
				mode: url.searchParams.get('mode'),
				iters,
				x: burn(module, iters)
			});
		}
		return Response.json(report('durable-object'));
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/burn') {
			const iters = Number(url.searchParams.get('iters') ?? 1e8);
			const module = url.searchParams.get('mode') === 'startup' ? workStartup : workBundled;
			return Response.json({
				mode: url.searchParams.get('mode'),
				iters,
				x: burn(module, iters)
			});
		}
		if (url.pathname === '/pack') return Response.json(pack);
		if (url.pathname === '/do')
			return env.PROBE.get(env.PROBE.idFromName(url.searchParams.get('do') ?? 'a')).fetch(
				request
			);
		return Response.json(report('worker'));
	}
} satisfies ExportedHandler<Env>;
