import { bootstrapOf, type BootstrapIndex } from '../../../src/worker/bootstrap.ts';
import { Machine } from '../../../src/worker/machine/machine.ts';
import { siteOptions, type SiteBuild } from '../../../src/worker/site-machine.ts';

export interface Reading {
	restoreMs: number;
	runMs: number;
	output: string;
	memory: WebAssembly.Memory;
}

/**
 * restores the image's checkpointed job and runs it to its end mark; `memory` is the previous
 * restore's, when the isolate has one
 */
export async function restoreAndRun(
	build: SiteBuild,
	index: BootstrapIndex,
	chunk: (n: number) => Promise<Uint8Array>,
	host: {
		sha256: (bytes: Uint8Array) => string;
		sleep: (ms: number) => Promise<void>;
		now: () => number;
		memory?: WebAssembly.Memory;
	},
	end = 'DONE2',
	type?: string
): Promise<Reading> {
	let output = '';
	const options = siteOptions(build, {
		sha256: host.sha256,
		memory: host.memory,
		write: (text) => void (output += text)
	});
	const image = bootstrapOf(index, chunk);
	const t0 = host.now();
	const machine = await Machine.restore(options, image.snapshot, undefined, image.lazy);
	if (type) machine.type(type);
	const t1 = host.now();
	const outcome = await machine.run(
		() => output.includes(end) || !!machine.crashed,
		(ms) => host.sleep(Math.min(ms, 50)),
		5_000_000
	);
	const t2 = host.now();
	if (!output.includes(end)) throw new Error(`no end mark (${outcome}): ${output.slice(-300)}`);
	return { restoreMs: t1 - t0, runMs: t2 - t1, output, memory: machine.memory };
}
