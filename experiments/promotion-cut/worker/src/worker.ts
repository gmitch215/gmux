// @ts-nocheck (burrow's dist is plain JS, copied in by build.sh)
import { DurableObject } from 'cloudflare:workers';
import { createInterpreter } from './vendor/interpret.js';
import wasm3 from './vendor/wasm3.wasm';
import iso from './iso.bin';
import nopsBytes from './nops.bin';

/**
 * The isolated crossing on the deployed runtime: `/run?arm=cross3&n=1000000` runs a wasm3 guest whose loop
 * calls a thunk (host import, JS glue as ladder.ts builds it, a V8 export that sets the stack pointer)
 * n times; `empty3` is the same loop without the call. The loop runs in a Durable Object (a plain Worker
 * on Free is cut at its CPU limit at random). The clock stands still while code runs, so the caller times
 * the requests.
 */
const nops = new WebAssembly.Instance(new WebAssembly.Module(nopsBytes)).exports;
const ks = [2, 3, 5, 7];

export class Rig extends DurableObject {
	guest;
	counter = { n: 0 };
	isolate = crypto.randomUUID();
	served = 0;

	async load() {
		const vm = await createInterpreter({ module: wasm3 });
		const imports = Object.fromEntries(
			ks.map((k) => [
				`t${k}`,
				{
					signature: `i(${'i'.repeat(k)})`,
					fn: (...a) => {
						this.counter.n++;
						return nops[`n${k}`](...a);
					}
				}
			])
		);
		return vm.load(new Uint8Array(iso), { imports: { native: imports } });
	}

	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === '/ping') return Response.json({ isolate: this.isolate, served: this.served++ });
		this.guest ??= await this.load();
		const arm = url.searchParams.get('arm');
		const n = Number(url.searchParams.get('n'));
		this.counter.n = 0;
		const result = this.guest.call(arm, n) >>> 0;
		return Response.json({ arm, n, result, crossings: this.counter.n, isolate: this.isolate, served: this.served++ });
	}
}

export default {
	fetch(request, env) {
		return env.RIG.get(env.RIG.idFromName('tau')).fetch(request);
	}
};
