import { createHash } from 'node:crypto';
import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	statSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { appendCpio } from '../../scripts/wasm/cpio-append.ts';
import { Machine } from '../../src/worker/machine/machine.ts';

/**
 * GNU coreutils' shell tests on gmux, in batches, a fresh machine for each: the pruned tree from
 * tests/suites/coreutils-build.sh at /cu, its bash at /bin/bash (both x86-64, run by katybug), and
 * tests/suites/coreutils-test.sh printing a line per test. Runs the machines in Node, or with --url on
 * a deployed tests/suites/worker, retrying a batch whose machine the platform took away; --stage
 * writes the initramfs that Worker serves and exits.
 * `node --experimental-strip-types tests/suites/coreutils-gmux.ts <cu dir> <bash> [--url U | --stage F] [test...]`;
 * BATCH sets the tests per machine (default 20), PAGES the machine's memory (default 2400 in Node,
 * 800 deployed: a Free isolate running these at 1200 exceeds its 128 MB and is reset), WALL the ms a
 * deployed request runs the machine, CU_LOG=1 the end of each failing test's log, DEBUG=1 each
 * exchange with the Worker, RAW=<file> every machine's console, GMUX_BUILD another build
 */
const RESULT = /^(PASS|FAIL|SKIP|ERROR) (tests\/\S+)\r?$/gm;
const DRIVER = '/coreutils-test.sh';

/** the initramfs pairs (path in the machine=local file) for the tree, its bash and the driver */
export function pairs(cu: string, bash: string, driver: string): string[] {
	const walk = (dir: string): string[] =>
		readdirSync(dir).flatMap((n) => {
			const p = join(dir, n);
			return statSync(p).isDirectory() ? walk(p) : [p];
		});
	return [
		...walk(cu).map((f) => `/cu/${relative(cu, f)}=${f}`),
		`/bin/bash=${bash}`,
		`${DRIVER}=${driver}`
	];
}

/** the command a machine runs for one batch, ending with a marker the runner waits for */
export const command = (tests: string[], log = false) =>
	`${log ? 'CU_LOG=1 ' : ''}sh ${DRIVER} ${tests.join(' ')} 2>&1; echo END-$((6*7))`;

/** the driver's lines in a machine's output, one per test that finished */
export function results(output: string): Map<string, string> {
	return new Map([...output.matchAll(RESULT)].map((m) => [m[2]!, m[1]!]));
}

async function inNode(image: Uint8Array, tests: string[]): Promise<string> {
	const root = new URL('../../', import.meta.url).pathname;
	const build = process.env.GMUX_BUILD ?? join(root, 'build');
	const read = (p: string) => new Uint8Array(readFileSync(join(build, p)));
	const manifest = JSON.parse(readFileSync(join(build, 'kernel/manifest.json'), 'utf8'));
	let output = '';
	let typed = false;
	const machine = new Machine({
		vmlinux: new WebAssembly.Module(read('kernel/vmlinux.wasm')),
		initrd: image,
		cmdline: 'maxcpus=3 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0',
		registry: new Map([
			[manifest.busybox as string, new WebAssembly.Module(read('kernel/busybox.wasm'))],
			[manifest.katybug as string, new WebAssembly.Module(read('kernel/katybug.wasm'))]
		]),
		maximumPages: Number(process.env.PAGES ?? 2400),
		sha256: (b) => createHash('sha256').update(b).digest('hex'),
		sharedKernel: true,
		write: (text) => {
			output += text;
			if (!typed && output.includes('# ')) {
				typed = true;
				machine.type(`${command(tests, !!process.env.CU_LOG)}\n`);
			}
		}
	});
	const started = Date.now();
	await machine.run(
		() => output.includes('END-42') || Date.now() - started > tests.length * 600_000,
		(ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50)))
	);
	return output;
}

/** one batch on a deployed rig: boot, type the batch, poll until the marker; null if the machine was lost */
async function deployed(url: string, tests: string[]): Promise<string | null> {
	const name = `coreutils-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const get = async (path: string) => {
		const r = await fetch(`${url}${path}${path.includes('?') ? '&' : '?'}do=${name}`);
		const text = await r.text();
		// DEBUG=1 prints each exchange with the rig
		if (process.env.DEBUG)
			console.error(
				r.status,
				path.slice(0, 60),
				text.match(/<title>([^<]*)/)?.[1] ?? text.slice(0, 160)
			);
		try {
			return JSON.parse(text) as Record<string, any>;
		} catch {
			return {};
		}
	};
	// a new object spends its first requests being placed (tests/suites/worker/worker.ts)
	let boot: Record<string, any> = {};
	for (let i = 0; i < 6 && (boot.placing || !boot.instance); i++)
		boot = await get(`/boot?pages=${process.env.PAGES ?? 800}&wall=20000`);
	if (!boot.instance || boot.placing) return null;
	let out = '';
	try {
		const step = async (path: string) => {
			const r = await get(path);
			if (r.instance !== boot.instance || r.lost || r.placing) throw new Error('lost');
			return String(r.out ?? '');
		};
		const cmd = encodeURIComponent(command(tests, !!process.env.CU_LOG));
		// WALL: ms a request runs the machine (default 10000)
		const wall = process.env.WALL ?? '10000';
		out = await step(`/exec?cmd=${cmd}&until=END-42&wall=${wall}`);
		for (let i = 0; i < tests.length * 120 && !out.includes('END-42'); i++)
			out += await step(`/exec?until=END-42&wall=${wall}`);
	} catch {
		return null;
	} finally {
		await get('/abort');
	}
	return out;
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const flag = (name: string) =>
		args.includes(name) ? args.splice(args.indexOf(name), 2)[1]! : null;
	const url = flag('--url');
	const stage = flag('--stage');
	const [cu, bash, ...only] = args;
	if (!cu || !bash)
		throw new Error(
			'usage: coreutils-gmux.ts <cu dir> <bash> [--url U | --stage <initramfs>] [test...]'
		);
	const all = only.length
		? only
		: readFileSync(join(cu, 'tests.txt'), 'utf8').split('\n').filter(Boolean);
	const size = Number(process.env.BATCH ?? 20);
	const root = new URL('../../', import.meta.url).pathname;
	const build = process.env.GMUX_BUILD ?? join(root, 'build');
	// the machine's initramfs: build/kernel's with the tree, its bash and the driver
	const initrd = stage ?? join(mkdtempSync(join(tmpdir(), 'gmux-coreutils-')), 'initramfs.cpio');
	if (!url) {
		mkdirSync(dirname(initrd), { recursive: true });
		appendCpio(
			join(build, 'kernel/initramfs.bin'),
			initrd,
			pairs(cu, bash, join(import.meta.dirname, 'coreutils-test.sh'))
		);
	}
	if (stage) process.exit(0);
	const image = url ? new Uint8Array() : new Uint8Array(readFileSync(initrd));
	// a new deployment answers "Worker not found" for its Durable Objects for a while
	for (let waited = 0; url && waited < 180; waited += 5) {
		const r = await fetch(`${url}/abort?do=ready`).catch(() => null);
		if (r?.headers.get('content-type')?.includes('json')) break;
		await new Promise((r) => setTimeout(r, 5000));
	}
	let lost = 0;
	for (let i = 0; i < all.length; i += size) {
		const batch = all.slice(i, i + size);
		let out: string | null = null;
		for (let attempt = 0; attempt < 3 && out === null; attempt++) {
			out = url ? await deployed(url, batch) : await inNode(image, batch);
			if (out === null) lost++;
		}
		// RAW=<file> keeps every machine's console
		if (process.env.RAW) appendFileSync(process.env.RAW, out ?? '');
		const got = results(out ?? '');
		for (const t of batch) console.log(`${got.get(t) ?? 'LOST'} ${t}`);
	}
	if (lost) console.error(`machines lost to the platform: ${lost}`);
}
