import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashFiles, type Provenance, type RungProvenance } from './cache.ts';

const here = new URL('.', import.meta.url).pathname;
export const repo = join(here, '../../..');
export const node = [process.execPath, '--no-warnings', '--experimental-strip-types'];
export const ladder = join(repo, 'experiments/promotion-ladder/scripts/ladder.ts');
export const graphTs = join(repo, 'experiments/promotion-cut/scripts/graph.ts');
export const planTs = join(repo, 'experiments/promotion-cut/scripts/plan.ts');

/** recomputes the provenance on each call, so a load pays for the check */
export async function provenanceOf(root: string, tau: string, fractions: string) {
	const { provenance } = (await import(join(root, 'tools/interp/artifact.ts'))) as {
		provenance: (root: string) => { burrow: string; wasm3: string; tools: string };
	};
	const record = (): Provenance => {
		const b = provenance(root);
		return {
			format: 1,
			burrow: b.burrow,
			wasm3: b.wasm3,
			burrowTools: b.tools,
			tools: hashFiles([ladder, graphTs, planTs, join(root, 'tools/interp/mine-catalog.sh'), join(here, 'cache.ts'), join(here, 'pipeline.ts')]),
			params: `${tau}:${fractions}`
		};
	};
	const rungs = (): RungProvenance => ({ ...record(), wasmTools: execFileSync('wasm-tools', ['--version']).toString().trim() });
	return { record, rungs };
}

/** ladder.ts prepare on the planned sets; the files of the rungs that are a planned set, and rungs.json */
export function prepareRungs(guest: string, sets: string, dir: string): Record<string, Uint8Array> {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, 'sets.json'), sets);
	execFileSync(node[0]!, [...node.slice(1), ladder, 'prepare', guest, dir, join(dir, 'sets.json')], { stdio: ['ignore', 'ignore', 'inherit'] });
	const labels = new Set(Object.keys(JSON.parse(sets) as Record<string, string[]>));
	const manifest = JSON.parse(readFileSync(join(dir, 'rungs.json'), 'utf8')) as { rungs: { rung: number; label: string }[] };
	const files: Record<string, Uint8Array> = { 'rungs.json': readFileSync(join(dir, 'rungs.json')) };
	for (const r of manifest.rungs)
		if (labels.has(r.label)) for (const side of ['interp', 'native']) files[`rung${r.rung}.${side}.wasm`] = readFileSync(join(dir, `rung${r.rung}.${side}.wasm`));
	return files;
}
