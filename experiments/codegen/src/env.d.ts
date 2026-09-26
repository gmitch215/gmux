declare module '*.bin' {
	const bytes: ArrayBuffer;
	export default bytes;
}

declare module '*.wasm' {
	const module: WebAssembly.Module;
	export default module;
}
