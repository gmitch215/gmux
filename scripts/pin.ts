import { readFileSync } from 'node:fs';

/** prints one pin from src/sources.json: `pin.ts <source> <key>` */
const [name, key] = process.argv.slice(2);
const sources = JSON.parse(readFileSync(new URL('../src/sources.json', import.meta.url), 'utf8'));
const value = sources[name!]?.[key!];
if (value === undefined) throw new Error(`no pin ${name}.${key}`);
console.log(value);
