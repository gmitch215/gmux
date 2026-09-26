declare module '*.wasm' {
	const module: WebAssembly.Module;
	export default module;
}

// build/ is not committed; this types it where a checkout has none (CI, docs)
declare module '*/kernel/manifest.json' {
	const manifest: { busybox: string; katybug: string };
	export default manifest;
}

declare module '*.bin' {
	const bytes: ArrayBuffer;
	export default bytes;
}
