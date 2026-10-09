import { readFileSync } from 'node:fs';

/**
 * Shares of a node --cpu-prof profile of serve.ts MODE=bench: the machine's wasm, the four net
 * imports (inclusive of what they call), the web streams code, the garbage collector and the rest.
 * A sample belongs to the innermost import frame on its stack, so the crossing's copy, its queueing
 * and its enqueue are inside it; wasm and the streams code are counted by their own self time.
 * `node --no-warnings --experimental-strip-types experiments/serving/scripts/prof.ts <file.cpuprofile> [...]`
 */
interface Node {
	id: number;
	callFrame: { functionName: string; url: string; lineNumber: number };
	children?: number[];
}
interface Profile {
	nodes: Node[];
	samples: number[];
	timeDeltas: number[];
}

const files = process.argv.slice(2);
if (!files.length) throw new Error('usage: prof.ts <file.cpuprofile> [...]');
const imports = ['next', 'send', 'end', 'listen'];
const isImport = (n: Node) =>
	n.callFrame.url.endsWith('/ingress.ts') && imports.includes(n.callFrame.functionName);
const isWasm = (n: Node) =>
	n.callFrame.url.startsWith('wasm://') || n.callFrame.functionName.startsWith('wasm-function');
const isStreams = (n: Node) => n.callFrame.url.includes('internal/webstreams');
const isGc = (n: Node) => n.callFrame.functionName === '(garbage collector)';
const isIdle = (n: Node) => n.callFrame.functionName === '(idle)';

for (const file of files) {
	const profile: Profile = JSON.parse(readFileSync(file, 'utf8'));
	const byId = new Map(profile.nodes.map((n) => [n.id, n]));
	const parent = new Map<number, number>();
	for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
	const self = new Map<number, number>();
	profile.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0)));
	const total = [...self].reduce((n, [id, t]) => n + (isIdle(byId.get(id)!) ? 0 : t), 0);
	const shares = new Map<string, number>();
	const add = (key: string, t: number) => shares.set(key, (shares.get(key) ?? 0) + t);
	const insideSend = new Map<string, number>();
	for (const [id, t] of self) {
		const node = byId.get(id)!;
		if (isIdle(node)) continue;
		// the innermost import frame above (or at) the sample, and what the sample was inside it
		let at: Node | undefined = node;
		let imported: Node | undefined;
		while (at) {
			if (isImport(at)) {
				imported = at;
				break;
			}
			const up = parent.get(at.id);
			at = up === undefined ? undefined : byId.get(up);
		}
		if (imported) {
			add(`import ${imported.callFrame.functionName}`, t);
			if (imported.callFrame.functionName === 'send') {
				const inner = isStreams(node)
					? 'web streams (queueing, enqueue)'
					: isImport(node)
						? 'the import body'
						: isGc(node)
							? 'garbage collector'
							: `other: ${node.callFrame.functionName || '(anonymous)'}`;
				insideSend.set(inner, (insideSend.get(inner) ?? 0) + t);
			}
		} else if (isWasm(node)) add('guest wasm (self)', t);
		else if (isStreams(node)) add('web streams outside the imports (self)', t);
		else if (isGc(node)) add('garbage collector outside the imports', t);
		else if (node.callFrame.functionName === '(program)') add('(program): native code, no JS frame', t);
		else add(`other JS: ${node.callFrame.url.split('/').slice(-2).join('/') || '(native)'}`, t);
	}
	const pct = (t: number) => ((100 * t) / total).toFixed(1);
	console.log(`\n${file}: ${(total / 1000).toFixed(1)} ms busy, ${profile.samples.length} samples\n`);
	console.log('| share of busy time | ms | % |\n| --- | --- | --- |');
	for (const [key, t] of [...shares].sort((a, b) => b[1] - a[1]).slice(0, 14))
		console.log(`| ${key} | ${(t / 1000).toFixed(1)} | ${pct(t)} |`);
	console.log('\ninside the send import:\n\n| part | ms | % of busy |\n| --- | --- | --- |');
	for (const [key, t] of [...insideSend].sort((a, b) => b[1] - a[1]).slice(0, 10))
		console.log(`| ${key} | ${(t / 1000).toFixed(1)} | ${pct(t)} |`);
	console.log('\ntop frames by self time:\n\n| function | where | ms | % of busy |\n| --- | --- | --- | --- |');
	const top = [...self]
		.filter(([id]) => !isIdle(byId.get(id)!))
		.sort((a, b) => b[1] - a[1])
		.slice(0, 20);
	for (const [id, t] of top) {
		const c = byId.get(id)!.callFrame;
		console.log(
			`| ${c.functionName || '(anonymous)'} | ${c.url.split('/').slice(-2).join('/') || '(native)'}:${c.lineNumber} | ${(t / 1000).toFixed(1)} | ${pct(t)} |`
		);
	}
}
