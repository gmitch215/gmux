import { createHash } from 'node:crypto';
import { siteOptions } from '../../../../src/worker/site-machine.ts';
import { booted, type Arm } from '../../src/drive.ts';
import busybox from './busybox.async.wasm';
import busyboxGuard from './busybox.guard.wasm';
import bzip2 from './bzip2.async.wasm';
import gawk from './gawk.async.wasm';
import gzip from './gzip.async.wasm';
import hashes from './hashes.json';
import initrd from './initrd.bin';
import katybug from './katybug.wasm';
import lua from './lua.async.wasm';
import manifest from './manifest.json';
import sed from './sed.async.wasm';
import sqlite from './sqlite.async.wasm';
import vmlinux from './vmlinux.async.wasm';

const programs: Record<string, WebAssembly.Module> = { lua, gzip, bzip2, sqlite, sed, gawk };

/** one machine for the isolate's life; POST /exec types the body's line and answers with its output */
let machine: Promise<Arm> | undefined;
let queue: Promise<unknown> = Promise.resolve();

function boot() {
	const options = siteOptions(
		{ vmlinux, busybox, busyboxGuard, katybug, initrd: new Uint8Array(initrd as ArrayBuffer), manifest },
		{ sha256: (bytes) => createHash('sha256').update(bytes).digest('hex'), write: () => {} }
	);
	for (const [name, module] of Object.entries(programs)) options.registry.set((hashes as Record<string, string>)[name]!, module);
	options.maximumPages = 4096;
	return booted(options, 'workerd');
}

export default {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/boot') {
			await (machine ??= boot());
			return new Response('booted\n');
		}
		if (url.pathname !== '/exec' || request.method !== 'POST') return new Response('POST /exec {cmd, k, out} or /boot\n', { status: 404 });
		const { cmd, k, out } = (await request.json()) as { cmd: string; k: number; out: boolean };
		const run = queue.then(async () => (await (machine ??= boot())).exec(cmd, k, out));
		queue = run.catch(() => {});
		try {
			return new Response((await run).out);
		} catch (error) {
			return new Response(String((error as Error).stack ?? error), { status: 500 });
		}
	}
};
