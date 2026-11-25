import { readFileSync } from 'node:fs';
import { PLAIN_IMPORTS } from '../../src/worker/machine/machine.ts';
import { readLeb, sections, skipImport, text } from './binary.ts';

/**
 * Refuses an asyncified program the host could not recycle: it must keep the share build's notes
 * and exported globals, import a mutable memory base, import nothing outside the plain set and
 * export the asyncify state. `--plain` is for a program that is not a share build (lighttpd): it
 * keeps the data and table notes and the globals, and has no share note or mutable memory base.
 * `check-async.ts [--plain] busybox.share.wasm busybox.async.wasm`
 */
const plain = process.argv[2] === '--plain';
const [shared, asynced] = process.argv
	.slice(plain ? 3 : 2)
	.map((path) => new Uint8Array(readFileSync(path!)));
const a = new WebAssembly.Module(shared!);
const b = new WebAssembly.Module(asynced!);
const problems: string[] = [];
const note = (module: WebAssembly.Module, name: string) => {
	const s = WebAssembly.Module.customSections(module, name)[0];
	return s ? new DataView(s).getUint32(0, true) : null;
};
for (const name of plain
	? ['gmux.data', 'gmux.table']
	: ['gmux.share', 'gmux.data', 'gmux.table']) {
	if (note(b, name) === null) problems.push(`no ${name} section`);
	else if (note(a, name) !== note(b, name)) problems.push(`${name} differs from the share build`);
}
const globals = (module: WebAssembly.Module) =>
	WebAssembly.Module.exports(module)
		.filter((e) => /^gmux_g\d+$/.test(e.name))
		.map((e) => e.name)
		.sort()
		.join(',');
if (globals(a) !== globals(b))
	problems.push('the exported gmux_g globals differ from the share build');
const exported = new Set(WebAssembly.Module.exports(b).map((e) => e.name));
for (const name of ['asyncify_get_state', 'asyncify_start_unwind', 'asyncify_start_rewind'])
	if (!exported.has(name)) problems.push(`no ${name} export`);
for (const i of WebAssembly.Module.imports(b))
	if (i.module !== 'env' || !PLAIN_IMPORTS.has(i.name))
		problems.push(`import ${i.module}.${i.name} is outside the plain set`);
let mutable = false;
for (const [id, , start] of sections(asynced!)) {
	if (id !== 2) continue;
	let [count, k] = readLeb(asynced!, start);
	while (count--) {
		const [mn, m0] = readLeb(asynced!, k);
		const [nn, n0] = readLeb(asynced!, m0 + mn);
		const name = text.decode(asynced!.subarray(n0, n0 + nn));
		k = n0 + nn;
		const kind = asynced![k++]!;
		if (kind === 3 && name === '__memory_base') mutable = asynced![k + 1] === 1;
		k = skipImport(asynced!, kind, k);
	}
}
if (!plain && !mutable) problems.push('__memory_base is not a mutable import');
if (problems.length) {
	console.error(`check-async: ${problems.join('; ')}`);
	process.exit(1);
}
console.log(`check-async: ok (${globals(b).split(',').length} exported globals)`);
