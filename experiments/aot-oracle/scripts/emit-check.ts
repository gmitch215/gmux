import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { appendCpio } from '../../../scripts/wasm/cpio-append.ts';
import { stub } from '../../../scripts/wasm/exec-stubs.ts';
import { Machine } from '../../../src/worker/machine/machine.ts';

/**
 * Runs guests in the V8 machine against a katybug module with emitted regions and against the interpreter-only module in the
 * same machine, and compares what they print and their exit status.
 *
 * `emit-check.ts <kernel dir> <jobs.tsv> [--expect-fail]` where each line is `label <TAB> module dir <TAB> guest ELF <TAB> command`
 * (the module dir holds katybug.wasm and katybug.inst.wasm; the command runs in the machine's shell with $G the guest and $B
 * /bin; the guest is /bin/<its file name>; an optional fifth column is a file of native Linux's output that it must equal) and the
 * reference module dir comes from REF (an interpreter-only build). A job passes when its output and status equal
 * the reference's for the same guest and command; with `--expect-fail` every job must differ (a mutant). Exit status 1 on any
 * unexpected result.
 */
const [kernel = '', jobsPath = '', ...flags] = process.argv.slice(2);
const expectFail = flags.includes('--expect-fail');
const refDir = process.env.REF ?? '';
if (!kernel || !jobsPath || !refDir) throw new Error('usage: REF=<interpreter-only module dir> emit-check.ts <kernel dir> <jobs.tsv> [--expect-fail]');
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const read = (p: string) => new Uint8Array(readFileSync(p));
const manifest = JSON.parse(readFileSync(join(kernel, 'manifest.json'), 'utf8'));
const work = mkdtempSync(join(tmpdir(), 'emit-check-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.min(ms, 5)));
const busybox = new WebAssembly.Module(read(join(kernel, 'busybox.wasm')));
const vmlinux = new WebAssembly.Module(read(join(kernel, 'vmlinux.wasm')));
const timeoutMs = Number(process.env.TIMEOUT_MS ?? 900_000);

async function run(moduleDir: string, guest: string, command: string): Promise<{ text: string; status: string; ms: number }> {
	const raw = read(join(moduleDir, 'katybug.wasm'));
	const registry = new Map<string, WebAssembly.Module>([
		[manifest.busybox, busybox],
		[sha256(raw), new WebAssembly.Module(read(join(moduleDir, 'katybug.inst.wasm')))]
	]);
	const small = stub(raw);
	if (!small) throw new Error(`${moduleDir}: no dylink.0 section`);
	writeFileSync(join(work, 'katybug.stub'), small);
	const cpio = join(work, 'initrd.cpio');
	appendCpio(join(kernel, 'initramfs.bin'), cpio, ['/bin/katybug=' + join(work, 'katybug.stub'), `/bin/${basename(guest)}=${guest}`]);
	let output = '';
	const m = new Machine({
		vmlinux,
		initrd: read(cpio),
		cmdline: 'maxcpus=3 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0',
		registry,
		maximumPages: 4096,
		sha256,
		sharedKernel: true,
		write: (t) => (output += t)
	});
	const booted = await m.run(() => output.includes('# '), sleep, 120_000);
	if (booted !== 'until') throw new Error(`${moduleDir}: no shell (${booted})`);
	const mark = `@@${Math.random().toString(36).slice(2, 8)}`;
	const from = output.length;
	const t = performance.now();
	m.type(`G=/bin/${basename(guest)}; B=/bin; ${command}; echo "${mark.slice(0, 2)}""${mark.slice(2)} $?"\n`);
	const outcome = await m.run(() => output.indexOf(mark, from) >= 0 && /\n/.test(output.slice(output.indexOf(mark, from))), sleep, timeoutMs);
	const ms = performance.now() - t;
	const at = output.indexOf(mark, from);
	if (outcome !== 'until') return { text: `# ${outcome}\n${output.slice(from).slice(-400)}`, status: 'timeout', ms };
	const status = output.slice(at + mark.length).trim().split(/\s/)[0]!;
	// what the guest printed: after the echoed command line (its last wrapped line ends at the first newline after `echo`)
	const echoed = output.indexOf('\n', output.indexOf(`echo "${mark.slice(0, 2)}"`, from));
	return { text: output.slice(echoed + 1, at), status: status ?? '?', ms };
}

const refs = new Map<string, Awaited<ReturnType<typeof run>>>();
let bad = 0;
let total = 0;
for (const line of readFileSync(jobsPath, 'utf8').split('\n')) {
	if (!line.trim() || line.startsWith('#')) continue;
	const [label = '', dir = '', guest = '', command = '', expected = ''] = line.split('\t');
	const key = `${guest}\t${command}`;
	if (!refs.has(key)) refs.set(key, await run(refDir, guest, command));
	const want = refs.get(key)!;
	let got: Awaited<ReturnType<typeof run>>;
	try {
		got = await run(dir, guest, command);
	} catch (e) {
		got = { text: `# ${String(e).slice(0, 200)}`, status: 'error', ms: 0 };
	}
	const native = expected ? readFileSync(expected, 'utf8').trim() === got.text.replace(/\r/g, '').trim() : true;
	const same = got.text === want.text && got.status === want.status && native;
	total++;
	const ok = expectFail ? !same : same;
	if (!ok) bad++;
	const md5 = (s: string) => createHash('md5').update(s).digest('hex').slice(0, 8);
	console.log(`${ok ? (expectFail ? 'FAILS' : 'PASS') : expectFail ? 'PASSED-BUT-SHOULD-FAIL' : 'FAIL'} ${label} status ${got.status} (ref ${want.status}) out ${md5(got.text)} (ref ${md5(want.text)}) ${got.ms.toFixed(0)} ms (ref ${want.ms.toFixed(0)} ms) [${got.text.trim().split("\n")[0]?.slice(0, 48)}]`);
	if (!same && process.env.SHOW) {
		const n = Number(process.env.SHOW_LEN ?? 1500);
		console.log(`--- got\n${got.text.slice(0, n)}\n--- want\n${want.text.slice(0, n)}`);
	}
}
console.log(`${total} jobs, ${total - bad} ${expectFail ? 'failed as expected' : 'PASS'}, ${bad} ${expectFail ? 'did not fail' : 'FAIL'}`);
process.exit(bad ? 1 : 0);
