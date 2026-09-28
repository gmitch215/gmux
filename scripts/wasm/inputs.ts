import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The hash of what scripts/build-linux.sh builds build/kernel from: src/sources.json, then every
 * src/<part>/patches file in byte order. The pipeline writes it to out/INPUTS and
 * scripts/build-kernel.sh into build/kernel/manifest.json, so a kernel staged from other patches is
 * caught before its probes run. `inputs.ts [repo root]`
 */
export function inputs(root: string): string {
	const src = join(root, 'src');
	const patches = readdirSync(src, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.flatMap((d) => {
			try {
				return readdirSync(join(src, d.name, 'patches'))
					.filter((f) => !f.startsWith('.'))
					.map((f) => `${d.name}/patches/${f}`);
			} catch {
				return [];
			}
		})
		.sort();
	const hash = createHash('sha256');
	for (const file of ['sources.json', ...patches]) hash.update(readFileSync(join(src, file)));
	return hash.digest('hex');
}

if (import.meta.main ?? process.argv[1]?.endsWith('inputs.ts'))
	console.log(inputs(process.argv[2] ?? new URL('../../', import.meta.url).pathname));
