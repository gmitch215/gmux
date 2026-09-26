import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { appendCpio } from '../../../scripts/wasm/cpio-append.ts';
import { Machine, type MachineOptions } from '../../../src/worker/machine/machine.ts';

/**
 * programs built with resumable frames, checkpointed mid-flight, restored into a fresh machine and
 * run to the end; the transcript must equal an uninterrupted run's. tests/c/control-flow.c parks in recursion,
 * function pointers, setjmp/longjmp, a qsort callback, a signal handler and a side module calling back
 * into the program (by pointer and by import); Lua parks in io.read
 * inside pcall inside a coroutine 50 frames deep. With KATYBUG (the build's unfueled katybug.wasm) and
 * BASH (a static amd64 bash), bash runs through an evacuated Katybug and parks in read.
 * `node --experimental-strip-types experiments/evacuation/scripts/control-flow.ts [lua.wasm]` (after
 * boot stage.sh; lua.wasm is a census build, e.g. ~/gmux-rig/census)
 */
const root = new URL('../../../', import.meta.url).pathname;
const vendor = join(root, 'experiments/boot/vendor');
const build = join(root, 'build');
const work = mkdtempSync(join(tmpdir(), 'gmux-control-flow-'));
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { stdio: 'ignore' });
const manifest = JSON.parse(readFileSync(join(build, 'kernel/manifest.json'), 'utf8'));
const lua = process.argv[2];

/** the program as the host runs it: fuel and stack checks, every mutable global exported, resumable frames */
function evacuated(plain: string): [string, WebAssembly.Module] {
	const name = basename(plain, '.wasm');
	const at = (suffix: string) => join(work, `${name}.${suffix}.wasm`);
	sh(join(root, 'scripts/wasm/instrument.sh'), [plain, at('fuel')]);
	// PLAIN=1 runs the host's ordinary build, to tell an evacuation fault from the program's own
	if (process.env.PLAIN) return [sha256(new Uint8Array(readFileSync(plain))), new WebAssembly.Module(readFileSync(at('fuel')))];
	sh(join(root, 'scripts/ts'), [join(root, 'scripts/wasm/export-globals.ts'), at('fuel'), at('g'), '--all-mutable']);
	sh(process.execPath, [join(root, 'experiments/evacuation/scripts/evacuate.mjs'), at('g'), at('evac'), '--resume']);
	return [sha256(new Uint8Array(readFileSync(plain))), new WebAssembly.Module(readFileSync(at('evac')))];
}

const script = join(work, 'control-flow.lua');
writeFileSync(
	script,
	`local function deep(n)
	if n == 0 then
		local co = coroutine.create(function()
			local ok, v = pcall(function()
				io.write("park\\n") io.flush()
				error("thrown " .. io.read("l"), 0)
			end)
			coroutine.yield(tostring(ok) .. " " .. v)
		end)
		local _, v = coroutine.resume(co)
		return v
	end
	return deep(n - 1) .. ""
end
print("lua " .. deep(50))
print("lua done")
`
);
const plain = join(build, 'probes/control-flow.wasm');
// its side module (tests/c/side/callback.c), evacuated the same way
const side = join(build, 'probes/libcallback.so');
const initrd = join(work, 'initramfs.cpio');
const files = [
	`/bin/control-flow=${plain}`,
	`/lib/libcallback.so=${side}`,
	...(lua ? [`/bin/lua=${lua}`, `/control-flow.lua=${script}`] : []),
	...(process.env.BASH ? [`/bin/kbbash=${process.env.BASH}`] : [])
];
appendCpio(join(build, 'kernel/initramfs.bin'), initrd, files);

const flow = evacuated(plain);
const luaProgram = lua ? evacuated(lua) : null;
// binfmt_misc hands the foreign ELF to /bin/katybug, whose stub names the build's hash
const katybug = process.env.KATYBUG ? evacuated(process.env.KATYBUG) : null;
if (katybug && katybug[0] !== manifest.katybug) throw new Error('KATYBUG is not the build katybug');
let output = '';
const options: MachineOptions = {
	vmlinux: new WebAssembly.Module(readFileSync(join(vendor, 'vmlinux.async.wasm'))),
	initrd: new Uint8Array(readFileSync(initrd)),
	cmdline:
		'maxcpus=3 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0',
	registry: new Map([
		[manifest.busybox, new WebAssembly.Module(readFileSync(join(vendor, 'busybox.async.wasm')))],
		flow,
		evacuated(side),
		...(luaProgram ? [luaProgram] : []),
		...(katybug ? [katybug] : [])
	]),
	maximumPages: 2048,
	sha256,
	sharedKernel: true,
	asyncify: true,
	write: (text) => (output += text),
	...(process.env.HOSTLOG ? { log: (text: string) => console.error(text) } : {})
};
const run = (m: Machine, until: () => boolean, ms = 60_000) => {
	const t = Date.now();
	return m.run(() => until() || Date.now() - t > ms, (x) => new Promise((r) => setTimeout(r, Math.min(x, 5))));
};

interface Case {
	name: string;
	command: string;
	/** checkpoint once this is printed; null runs uninterrupted */
	marker: string | null;
	/** typed after the marker, in every arm */
	input?: string;
	/** before the marker: once the first is printed, the second is typed */
	before?: [string, string];
	done: string;
	prefix: string;
	/** the program's registry hash: a checkpoint must find it running, or it proves nothing */
	program: string;
	/** printed after the phase: a checkpoint taken once it is out landed past the phase it tests */
	after: string;
}

/** runs a case; the lines it prints under its prefix, and what happened */
async function once(c: Case) {
	output = '';
	let machine = new Machine(options);
	await run(machine, () => output.includes('# '));
	const start = output.length;
	machine.type(c.command);
	if (c.before) {
		const [text, typed] = c.before;
		await run(machine, () => output.slice(start).includes(text));
		machine.type(typed);
	}
	let note = 'uninterrupted';
	const marker = c.marker ?? (c.input ? 'park' : null);
	if (marker) {
		await run(machine, () => output.slice(start).includes(marker));
		// the program reaches its park within a few host turns
		await run(machine, () => false, 15);
	}
	if (c.marker) {
		try {
			const snapshot = await machine.checkpoint();
			if (!snapshot.runners.some((r) => r.user?.hash === c.program))
				note = 'the program was not running at the checkpoint';
			else {
				// a checkpointed machine cannot run again, so every arm continues from the restore
				machine = await Machine.restore(options, { ...snapshot, memory: snapshot.memory.slice() });
				note = output.slice(start).includes(c.after)
					? `the checkpoint landed past its phase (${c.after} already out)`
					: 'checkpointed and restored';
			}
		} catch (error) {
			note = `checkpoint refused: ${(error as Error).message}`;
		}
	}
	if (c.input) machine.type(c.input);
	await run(machine, () => output.slice(start).includes(c.done));
	const text = output
		.slice(start)
		.replace(/\r/g, '')
		.split('\n')
		.filter((l) => l.startsWith(c.prefix))
		.join('\n');
	return { text, note, crashed: machine.crashed };
}

const cases: Case[] = [1, 2, 3, 4, 5, 6, 7].map((n) => ({
	name: `c phase ${n}`,
	command: 'control-flow\n',
	marker: `phase ${n} begin`,
	// phases 6 and 7 each read a line; typed after the checkpoint, they wait in the terminal until
	// read. Phase 7's case answers phase 6 first, or it would checkpoint there
	...(n === 7 ? { before: ['phase 6 park', 'go\n'] as [string, string], input: 'go\n' } : { input: 'go\ngo\n' }),
	done: 'control flow done',
	prefix: 'phase ',
	program: flow[0],
	after: n < 7 ? `phase ${n + 1} begin` : 'control flow done'
}));
if (lua)
	cases.push({ name: 'lua', command: 'lua /control-flow.lua\n', marker: 'park', input: 'hello\n', done: 'lua done', prefix: 'lua ', program: luaProgram![0], after: 'lua done' });

// the markers are split in the typed line, so its echo does not match them
if (katybug && process.env.BASH)
	cases.push({
		name: 'katybug',
		command: `kbbash -c 'echo "kb pa""rk"; read x; echo "kb g""ot $x"; echo "kb do""ne"'\n`,
		marker: 'kb park',
		input: 'hello\n',
		done: 'kb done',
		prefix: 'kb ',
		program: katybug[0],
		after: 'kb got'
	});

let failed = 0;
const references = new Map<string, string>();
for (const c of cases) {
	if (!references.has(c.command)) {
		const reference = await once({ ...c, marker: null });
		if (!output.includes(c.done) || reference.crashed) {
			console.log(`FAIL ${c.name}: reference run`, output.slice(-2000), reference.crashed);
			process.exit(1);
		}
		console.log(reference.text);
		references.set(c.command, reference.text);
	}
	// a phase can finish inside the host turns before the checkpoint; that tests nothing, so retry
	let got = await once(c);
	for (let tries = 1; tries < 3 && got.note.startsWith('the checkpoint landed past'); tries++)
		got = await once(c);
	const same = got.text === references.get(c.command);
	const ok = same && !got.crashed && got.note === 'checkpointed and restored';
	if (!ok) failed++;
	console.log(`${ok ? 'PASS' : 'FAIL'} ${c.name}: ${got.note}${same ? '' : ' (transcript differs)'}`);
	if (!same) console.log(output.slice(-1500), got.crashed);
}
process.exit(failed ? 1 : 0);
