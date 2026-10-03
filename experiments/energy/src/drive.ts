import { Machine, type MachineOptions } from '../../../src/worker/machine/machine.ts';

/** k runs of a census command, its output sunk to OUT unless wanted; IN is the input file */
export const loop = (cmd: string, k: number, io: { IN: string; OUT: string }, out: boolean) =>
	`i=0; while [ $i -lt ${k} ]; do { ${cmd.replace(/\bIN\b/g, io.IN)}; }${out ? '' : ` > ${io.OUT} 2>&1`}; i=$((i+1)); done`;

export interface Arm {
	name: string;
	/** k runs of the command; with out, the output of the run (checked against native), else sunk */
	exec(cmd: string, k: number, out: boolean): Promise<{ ms: number; out: string }>;
}

/** a booted machine whose commands are bracketed by markers; the host's time from typing to the end marker */
export async function booted(options: MachineOptions, name: string, wallMs = 1_200_000): Promise<Arm> {
	let output = '';
	const m = new Machine({ ...options, write: (text) => (output += text) });
	const idle = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 5)));
	const until = (want: () => boolean) => {
		const limit = performance.now() + wallMs;
		return m.run(() => want() || performance.now() > limit, idle);
	};
	if ((await until(() => output.includes('# '))) !== 'until') throw new Error(`${name}: no prompt\n${output.slice(-400)}`);
	let id = 0;
	const type = async (line: string) => {
		const mark = `${name}${id++}`;
		const from = output.length;
		const t = performance.now();
		m.type(`echo @@S$((7))${mark}@@; ${line}; echo @@E$((7))${mark}@@ $?\n`);
		const end = new RegExp(`@@E7${mark}@@ (\\d+)\\r?\\n`);
		const outcome = await until(() => end.test(output.slice(from)));
		const ms = performance.now() - t;
		const tail = output.slice(from);
		const status = end.exec(tail)?.[1];
		if (outcome !== 'until' || status !== '0') throw new Error(`${name}: ${line}: ${outcome}, status ${status}\n${tail.slice(-600)}`);
		const start = `@@S7${mark}@@`;
		const text = tail.slice(tail.indexOf(start) + start.length, tail.indexOf(`@@E7${mark}@@`)).replace(/\r/g, '').replace(/^\n/, '');
		return { ms, out: text };
	};
	await type('seq 1 400000 > /tmp/in');
	return { name, exec: (cmd, k, out) => type(loop(cmd, k, { IN: '/tmp/in', OUT: '/tmp/out' }, out)) };
}
