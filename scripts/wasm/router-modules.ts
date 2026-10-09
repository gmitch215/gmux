import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { compileRuntime, type HostRuntime } from '../../src/worker/machine/router.ts';

const root = new URL('../../', import.meta.url).pathname;
const sources = [join(root, 'src/gmux/core'), join(root, 'src/gmux/core/router')];
const outputs = ['router.wasm', 'statx.wasm', 'gmux-core.wasm'];
/** build/router, or GMUX_BUILD's, which is where the kernel rigs take their build from */
export const RUNTIME_BUILD = join(process.env.GMUX_BUILD ?? join(root, 'build'), 'router');

/** runs scripts/build-router.sh unless build/router is newer than every source */
export function buildRuntime(dir = RUNTIME_BUILD) {
	const newest = Math.max(
		...sources.flatMap((from) =>
			readdirSync(from, { withFileTypes: true })
				.filter((entry) => entry.isFile())
				.map((entry) => statSync(join(from, entry.name)).mtimeMs)
		),
		statSync(join(root, 'scripts/build-router.sh')).mtimeMs,
		statSync(join(root, 'scripts/build-core.sh')).mtimeMs,
		statSync(join(root, 'scripts/wasm/assemble-wat.ts')).mtimeMs
	);
	const stale = outputs.some(
		(name) => !existsSync(join(dir, name)) || statSync(join(dir, name)).mtimeMs < newest
	);
	if (stale) execFileSync(join(root, 'scripts/build-router.sh'), [dir], { stdio: 'inherit' });
}

/**
 * the compiled modules of a directory scripts/build-router.sh filled; `core: false` leaves the
 * scheduler core out, which runs the TypeScript scheduler
 */
export function hostRuntime(dir = RUNTIME_BUILD, { core = true } = {}): HostRuntime {
	const read = (name: string) => new Uint8Array(readFileSync(join(dir, name)));
	return compileRuntime(
		read('router.wasm'),
		read('statx.wasm'),
		core ? read('gmux-core.wasm') : undefined
	);
}
