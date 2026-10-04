import binaryen from 'binaryen';
import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Assembles a wat file that uses several memories and a shared one, which clang cannot write.
 * `assemble-wat.ts in.wat out.wasm`
 */
const [wat, wasm] = process.argv.slice(2);
if (!wat || !wasm) throw new Error('usage: assemble-wat.ts <in.wat> <out.wasm>');
const module = binaryen.parseText(readFileSync(wat, 'utf8'));
module.setFeatures(
	binaryen.Features.MultiMemory |
		binaryen.Features.Atomics |
		binaryen.Features.BulkMemory |
		binaryen.Features.BulkMemoryOpt
);
if (!module.validate()) throw new Error(`${wat}: does not validate`);
writeFileSync(wasm, module.emitBinary());
module.dispose();
