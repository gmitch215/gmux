import { readFileSync } from 'node:fs';

/**
 * prints one pin from src/sources.json: `pin.ts <source> <key>`; `repo` is the source's mirror in
 * src/mirrors.json when it has one, and `origin` is the repository the pin came from
 */
const read = (file: string) =>
	JSON.parse(readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'));
const [name, key] = process.argv.slice(2);
const sources = read('sources.json');
const mirrors = read('mirrors.json');
const value =
	key === 'repo'
		? (mirrors[name!] ?? sources[name!]?.repo)
		: key === 'origin'
			? sources[name!]?.repo
			: sources[name!]?.[key!];
if (value === undefined) throw new Error(`no pin ${name}.${key}`);
console.log(value);
