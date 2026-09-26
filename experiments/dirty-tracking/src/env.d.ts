declare module '*.wasm' {
	const module: WebAssembly.Module;
	export default module;
}

declare module '*.bin' {
	const bytes: ArrayBuffer;
	export default bytes;
}

declare namespace WebAssembly {
	class Suspending extends Function {
		constructor(fn: (...args: any[]) => unknown);
	}
	function promising(fn: Function): (...args: any[]) => Promise<any>;
}
