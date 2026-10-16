/**
 * Wraps the kernel's plain (non-suspending) imports when its instance is made: `timed` adds the host time
 * and calls of each by name, and the first call of `wasm_cpu_clock_get_monotonic` records the url V8 gives
 * the kernel module in a profile (`wasm://wasm/<hash>`), which names the kernel's samples where the build
 * has no name section. Install before the machine is made.
 */
export const imports = {
	us: {} as Record<string, number>,
	calls: {} as Record<string, number>,
	kernelUrl: ''
};

export function watchKernel(timed: boolean) {
	const Original = WebAssembly.Instance;
	(WebAssembly as any).Instance = class extends Original {
		constructor(module: WebAssembly.Module, importObject?: WebAssembly.Imports) {
			const env = importObject?.env as Record<string, unknown> | undefined;
			if (env && 'wasm_net_send' in env)
				for (const [name, fn] of Object.entries(env)) {
					if (typeof fn !== 'function') continue;
					imports.us[name] = 0;
					imports.calls[name] = 0;
					env[name] = (...args: unknown[]) => {
						if (!imports.kernelUrl && name === 'wasm_cpu_clock_get_monotonic') {
							const limit = Error.stackTraceLimit;
							Error.stackTraceLimit = 30;
							imports.kernelUrl = /wasm:\/\/wasm\/[0-9a-f]+/.exec(new Error().stack ?? '')?.[0] ?? '';
							Error.stackTraceLimit = limit;
						}
						if (!timed) return fn(...args);
						const t0 = performance.now();
						try {
							return fn(...args);
						} finally {
							imports.us[name]! += (performance.now() - t0) * 1000;
							imports.calls[name]!++;
						}
					};
				}
			super(module, importObject);
		}
	};
}
