/** hint.wat's loop in JavaScript, no wasm: the host's speed, to set wasm times against */
export function jsLoop(n: number): number {
	let acc = 0;
	for (let i = 0; i < n; i++) {
		acc = (acc + Math.imul(i, 3)) | 0;
		if ((i & 1023) === 0) acc ^= Math.imul(i ^ 0x5bd1e995, 31);
	}
	return acc;
}
