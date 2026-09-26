/** JSPI and wasm exception handling, which workerd and Node ship and the TypeScript lib does not describe yet */
declare namespace WebAssembly {
	class Suspending {
		constructor(fn: (...args: any[]) => unknown);
	}
	function promising(fn: Function): (...args: any[]) => Promise<any>;
	class Tag {
		constructor(type: { parameters: string[] });
	}
	class Exception {
		constructor(tag: Tag, payload: unknown[]);
	}
}
