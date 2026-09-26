import { readFileSync } from 'node:fs';
import { depths } from '../src/depth.ts';
console.log(JSON.stringify(await depths(new WebAssembly.Module(readFileSync(new URL('../src/rec.wasm', import.meta.url))))));
