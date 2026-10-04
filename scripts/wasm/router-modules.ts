import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { compileRouter, type RouterModules } from '../../src/worker/machine/router.ts';

const root = new URL('../../', import.meta.url).pathname;
const sources = join(root, 'src/gmux/core/router');
/** build/router, or GMUX_BUILD's, which is where the kernel rigs take their build from */
export const ROUTER_BUILD = join(process.env.GMUX_BUILD ?? join(root, 'build'), 'router');

/** runs scripts/build-router.sh unless build/router is newer than every source */
export function buildRouter(dir = ROUTER_BUILD) {
	const outputs = ['router.wasm', 'statx.wasm'].map((name) => join(dir, name));
	const newest = Math.max(
		...readdirSync(sources).map((name) => statSync(join(sources, name)).mtimeMs),
		statSync(join(root, 'scripts/build-router.sh')).mtimeMs,
		statSync(join(root, 'scripts/wasm/assemble-wat.ts')).mtimeMs
	);
	const stale = outputs.some((path) => !existsSync(path) || statSync(path).mtimeMs < newest);
	if (stale) execFileSync(join(root, 'scripts/build-router.sh'), [dir], { stdio: 'inherit' });
}

/** the compiled router and statx modules of a directory scripts/build-router.sh filled */
export function routerModules(dir = ROUTER_BUILD): RouterModules {
	const read = (name: string) => new Uint8Array(readFileSync(join(dir, name)));
	return compileRouter(read('router.wasm'), read('statx.wasm'));
}
