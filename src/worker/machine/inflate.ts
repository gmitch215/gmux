import { constants, createInflateRaw } from 'node:zlib';
import type { HostInflater } from './machine.ts';

interface Engine {
	_handle: {
		writeSync(
			flush: number,
			input: Uint8Array,
			inOffset: number,
			inLength: number,
			output: Uint8Array,
			outOffset: number,
			outLength: number
		): void;
	};
	_writeState: Uint32Array;
	destroyed: boolean;
}

/**
 * a `HostInflater` over node:zlib's raw inflate. node has no public call that decodes into a buffer
 * of the caller's size and says how much input it took, so this drives the engine's own `writeSync`
 * the way `zlib.inflateRawSync` does
 */
export function nodeInflater(): HostInflater {
	const stream = createInflateRaw();
	stream.on('error', () => {});
	const engine = stream as unknown as Engine;
	return {
		step(input, output) {
			engine._handle.writeSync(
				constants.Z_NO_FLUSH,
				input,
				0,
				input.length,
				output,
				0,
				output.length
			);
			if (engine.destroyed) throw new Error('invalid deflate data');
			const outLeft = engine._writeState[0]!;
			const inLeft = engine._writeState[1]!;
			return {
				read: input.length - inLeft,
				written: output.length - outLeft,
				ended: inLeft > 0 && outLeft > 0
			};
		}
	};
}
