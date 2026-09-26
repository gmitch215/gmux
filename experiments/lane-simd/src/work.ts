/** operations per repetition of each kernel in kernels.c */
export const OPS: Record<string, number> = { sgemm: 2 * 256 ** 3, dot8: 2 * (1 << 24), conv3: 18 * 512 * 512 };

export type Kernels = Record<'init' | 'sgemm' | 'dot8' | 'conv3', (reps?: number) => number>;

/** an instance with its data filled, each kernel warmed so the measured calls run optimized code */
export function prepare(module: WebAssembly.Module): Kernels {
	const k = new WebAssembly.Instance(module).exports as unknown as Kernels;
	k.init();
	for (let i = 0; i < 3; i++) k.sgemm(1), k.dot8(1), k.conv3(1);
	return k;
}
