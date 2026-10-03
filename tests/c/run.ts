import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendCpio } from '../../scripts/wasm/cpio-append.ts';
import { inputs } from '../../scripts/wasm/inputs.ts';
import { Machine } from '../../src/worker/machine/machine.ts';
import { hostOnly, leaks, SURFACE, watch } from './authority.ts';

/**
 * Boots build/kernel with the tests/c probes from build/probes and checks each one's output;
 * GMUX_BUILD points at another build, FROZEN=1 stops the host clock.
 * `node --experimental-strip-types tests/c/run.ts [probe...]`
 */
interface Probe {
	setup?: string;
	lines: string[];
	passes?: number;
	host?: string;
	/** the program under build/ when it is not probes/<name>.wasm (null: the build's own /bin/<name>),
	    and the command when not its name */
	program?: string | null;
	cmd?: string;
	/** more programs, registered like `program`: path in the machine -> path under build/ */
	programs?: Record<string, string>;
	/** more initramfs files: path in the machine -> path under build/ */
	files?: Record<string, string>;
	/** wasm side modules under build/ that dlopen may load: registered by the hash of the file */
	side?: string[];
	/** build it with resumable frames (experiments/evacuation/scripts/evacuate.ts), as fork needs; a list names the programs that fork */
	evacuate?: boolean | string[];
	/** the machine's memory in 64 KiB pages: a probe that sets it boots a machine of its own */
	pages?: number;
}
const probes: Record<string, Probe> = {
	// SECURITY.md: root is trusted with the machine; a non-root task runs its guarded build, which
	// checks loads and stores, and reaches a shared mapping (System V, POSIX, a file, anonymous)
	// only while it holds it; past 4,095 regions a mapping is refused
	isolation: {
		lines: ['TRUST kernel-address write accepted'],
		passes: 90
	},
	// SECURITY.md's authority domains: root looks through all of the machine's memory for what the
	// host holds (a Worker env's secret, a host secret, the owner token), and for a device or a
	// network path to storage or the Cloudflare API; the host scans every guest memory after
	authority: {
		lines: ['kernel command line', 'Network unreachable'],
		passes: 10
	},
	vf: { lines: ['from-exec', 'child 1 exited 0', 'second exited 7', 'third exited 9'] },
	sig: { lines: ['handler slept', 'after pause'] },
	thr: { lines: ['threads count 40000'] },
	spin: { lines: [], passes: 3 },
	// caught at the stack's own bound, not by running off the end of memory
	stack: { lines: [], passes: 2, host: 'fault: stack overflow' },
	time: { lines: [], passes: 5 },
	// foreign ELFs (tests/c/katybug/run.sh builds them) run by katybug inside the machine
	katybug: {
		program: null,
		files: {
			'/bin/hello-x86': 'katybug/hello-x86',
			'/bin/hello-a64': 'katybug/hello-a64',
			'/bin/guest-x86': 'katybug/guest-x86',
			'/bin/guest-a64': 'katybug/guest-a64',
			'/bin/signals-x86': 'katybug/signals-x86',
			'/bin/signals-a64': 'katybug/signals-a64'
		},
		// the ELFs run by execve through binfmt_misc, then katybug named explicitly
		cmd:
			'/bin/hello-x86; /bin/hello-a64; /bin/guest-x86 > /tmp/kx; echo "x86 rc $?"; ' +
			'katybug /bin/guest-a64 > /tmp/ka; echo "a64 rc $?"; cmp /tmp/kx /tmp/ka && echo same; grep fib25 /tmp/kx; ' +
			'/bin/signals-x86 > /tmp/sx; echo "signals rc $?"; /bin/signals-a64 > /tmp/sa; cmp /tmp/sx /tmp/sa && echo "signals same"; ' +
			'grep "load after repair" /tmp/sx',
		lines: [
			'hello',
			'x86 rc 119',
			'a64 rc 119',
			'same',
			'fib25 75025',
			'signals rc 143',
			'signals same',
			'load after repair 42'
		]
	},
	// static amd64 coreutils, bash, sqlite3 and curl (tests/c/katybug/transcript.sh stages them),
	// expected lines from their native x86-64 run
	userland: {
		program: null,
		setup: 'ifconfig lo 127.0.0.1 up',
		files: {
			'/bin/bash': 'katybug/transcript/ubin/bash',
			'/bin/coreutils': 'katybug/transcript/ubin/coreutils',
			'/bin/curl': 'katybug/transcript/ubin/curl',
			'/bin/sqlite3': 'katybug/transcript/ubin/sqlite3'
		},
		cmd:
			'coreutils --coreutils-prog=factor 1234567 600851475143; ' +
			'coreutils --coreutils-prog=timeout 0.2 coreutils --coreutils-prog=sleep 5; echo "timeout rc $?"; ' +
			"bash -c 'a=(3 1 2); echo ${#a[@]} ${a[@]:1}; declare -A m=([x]=1 [y]=2); echo ${m[y]} ${!m[@]}'; " +
			// guest forks: katybug's exec and state transfer (fork.c), as the machine cannot fork a wasm program
			'bash -c \'x=$(echo sub); echo $x; (exit 7); echo "subshell $?"; for i in 1 2 3; do echo $i | cat; done | wc -l\'; ' +
			"sqlite3 :memory: 'with recursive c(x) as (select 1 union all select x+1 from c where x<10000) " +
			"select count(*), sum(x), max(x), sum(x*x) % 1000003 from c;'; " +
			// katybug ran musl's strlen as a host kernel
			"KATYBUG_STATS=1 KATYBUG_PRIM_LOG=/tmp/pl sqlite3 :memory: 'select 1' > /dev/null 2>&1; echo \"prim strlen kernels $(grep -c 'prim strlen [1-9]' /tmp/pl)\"; " +
			'echo filed > /tmp/f; curl -s file:///tmp/f; ' +
			"{ printf 'HTTP/1.0 200 OK\\r\\n\\r\\nserved\\n' | nc -l -p 18083 > /dev/null; } & sleep 1; " +
			'curl -s http://127.0.0.1:18083/; wait',
		lines: [
			'1234567: 127 9721',
			'600851475143: 71 839 1471 6857',
			'timeout rc 124',
			'3 1 2',
			'2 y x',
			'sub',
			'subshell 7',
			'3',
			'10000|50005000|10000|334854',
			'prim strlen kernels 1',
			'filed',
			'served'
		]
	},
	// the console shell is interactive: a redirected group or loop reads its file to the end, not the
	// terminal after its first command (src/busybox/patches/0001)
	shell: {
		program: null,
		cmd:
			'printf \'a\\nb\\nc\\n\' > /tmp/rx; { read a; read b; echo "group $a $b"; } < /tmp/rx; ' +
			'while read l; do echo "loop $l"; done < /tmp/rx',
		lines: ['group a b', 'loop a', 'loop b', 'loop c']
	},
	// SECURITY.md: exec takes only registered modules; byte 200 is inside the stub's hash, and the
	// refused exec kills the process (SIGSEGV), not the machine
	unknown: {
		program: null,
		cmd:
			'cp /bin/busybox /tmp/x && printf "\\377" | dd of=/tmp/x bs=1 seek=200 conv=notrunc 2>/dev/null; ' +
			'/tmp/x true; echo "refused rc $?"; echo alive',
		lines: ['refused rc 139', 'alive']
	},
	// fork from a program with resumable frames; its frames resume in the parent and the child
	fork: {
		setup: 'ifconfig lo 127.0.0.1 up',
		evacuate: true,
		lines: ['exec from a fork child'],
		passes: 7
	},
	// zlib as a side module (dlopen/dlsym); the first lines are the same program's native output
	// against the same zlib
	dl: {
		files: { '/lib/libz.so': 'probes/libz.so' },
		side: ['probes/libz.so'],
		lines: [
			'zlib 1.3.1',
			'crc32 273b7535',
			'compressed 639 bytes (rc 0), adler32 99df58be',
			'round trip same (rc 0)'
		],
		passes: 8
	},
	posix: {
		setup: 'ifconfig lo 127.0.0.1 up; mkdir -p /lua-tests',
		lines: [],
		passes: 25
	},
	// perl's core XS modules as side modules: every extension loads through dlopen, and the script
	// prints what the same perl prints natively (perl-xs.out)
	perl: {
		program: 'perl/perl',
		files: { '/usr/lib/perl5/': 'perl/lib/', '/perl-xs.pl': 'tests/c/perl-xs.pl' },
		side: ['perl/lib/auto/'],
		cmd: 'perl -I/usr/lib/perl5 /perl-xs.pl',
		lines: readFileSync(new URL('./perl-xs.out', import.meta.url), 'utf8')
			.split('\n')
			.filter(Boolean)
	},
	// curl's own test suite: runtests.pl starts its HTTP server and runs the first test
	'curl-suite': {
		program: null,
		programs: {
			'/bin/perl': 'perl/perl',
			'/curl/src/curl': 'curl/src/curl',
			'/curl/tests/server/disabled': 'curl/tests/server/disabled',
			'/curl/tests/server/sws': 'curl/tests/server/sws',
			'/curl/tests/server/sockfilt': 'curl/tests/server/sockfilt'
		},
		files: {
			'/usr/lib/perl5/': 'perl/lib/',
			...Object.fromEntries(
				[
					'runtests.pl',
					'http-server.pl',
					...['getpart', 'globalconfig', 'directories', 'runner', 'servers', 'serverhelp']
						.concat([
							'pathhelp',
							'processhelp',
							'sshhelp',
							'testutil',
							'valgrind',
							'azure'
						])
						.concat(['appveyor', 'configurehelp'])
						.map((name) => `${name}.pm`),
					'data/test1'
				].map((file) => [`/curl/tests/${file}`, `curl/tests/${file}`])
			),
			'/curl/tests/data/DISABLED': 'tests/c/curl-disabled'
		},
		side: ['perl/lib/auto/'],
		evacuate: ['/bin/perl'],
		setup: 'ifconfig lo 127.0.0.1 up',
		cmd: 'export PERL5LIB=/usr/lib/perl5; cd /curl/tests && perl -I. runtests.pl -c /curl/src/curl 1',
		lines: ['test 0001...[HTTP GET]', '1 tests out of 1 reported OK: 100%']
	},
	// an 800-page machine (what a Free isolate holds) with 10 MB of files in memory runs 106 execs, as
	// a coreutils run's link loop does; each exec maps a stack and a data block of its own, and blocks
	// of 64 pages must still be free after them
	exec: {
		program: null,
		pages: 800,
		setup: 'dd if=/dev/zero of=/tmp/fill bs=1M count=10 2> /dev/null',
		cmd:
			'i=0; n=0; while [ $i -lt 106 ]; do ln -s x /tmp/l$i && n=$((n+1)); i=$((i+1)); done; ' +
			'echo "linked $n"; ' +
			'awk \'{ for (i = 11; i <= 19; i++) if ($i > 0) big += $i } END { print big ? "order 6 free" : "no order 6" }\' /proc/buddyinfo',
		lines: ['linked 106', 'order 6 free']
	}
};

const root = new URL('../../', import.meta.url).pathname;
const build = process.env.GMUX_BUILD ?? join(root, 'build');
// scripts/census.sh builds these, not the pipeline: a run of every probe skips them without the build
const census: Record<string, string> = { perl: 'perl/perl', 'curl-suite': 'curl/src/curl' };
const names = process.argv.slice(2).length
	? process.argv.slice(2)
	: Object.keys(probes).filter((name) => !census[name] || existsSync(join(build, census[name]!)));
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const read = (path: string) => new Uint8Array(readFileSync(join(build, path)));
// a path ending in / stands for the library files under it (pod and unicore stay out); one
// under tests/ is read from the repo
const under = (dir: string, keep: RegExp) =>
	(readdirSync(join(build, dir), { recursive: true }) as string[])
		.filter((rel) => keep.test(rel) && statSync(join(build, dir, rel)).isFile())
		.map((rel) => rel.toString());
const library = /^(?!unicore\/|pod\/|Pod\/).*\.(pm|pl|so|ph)$/;
const sideModules = (paths: string[]) =>
	paths.flatMap((path) =>
		path.endsWith('/') ? under(path, /\.so$/).map((rel) => path + rel) : [path]
	);
const source = (path: string) => (path.startsWith('tests/') ? join(root, path) : join(build, path));
const fileEntries = (name: string) =>
	Object.entries(probes[name]!.files ?? {}).flatMap(([to, from]) =>
		from.endsWith('/')
			? under(from, library).map((rel) => `${to}${rel}=${join(build, from, rel)}`)
			: [`${to}=${source(from)}`]
	);

// SHARE=1: every program that can be shared runs each of its processes on one instance
const share = !!process.env.SHARE;
const busybox = read(share ? 'kernel/busybox.share.wasm' : 'kernel/busybox.wasm');
const manifest = JSON.parse(readFileSync(join(build, 'kernel/manifest.json'), 'utf8'));
// a kernel staged from other patches than this tree's fails probes for reasons the tree does not have
if (!manifest.inputs)
	console.log('note: build/kernel does not record the patches it was built from; not checked');
else if (manifest.inputs !== inputs(root)) {
	console.log(
		'build/kernel was built from other patches than this tree (src/sources.json, src/*/patches): ' +
			'rebuild it with scripts/build-linux.sh and scripts/build-kernel.sh'
	);
	process.exit(1);
}
const registry = new Map([[manifest.busybox as string, new WebAssembly.Module(busybox)]]);
// the build's own katybug, which binfmt_misc runs for foreign executables (src/rootfs/etc/init.d/rcS)
if (manifest.katybug)
	registry.set(manifest.katybug, new WebAssembly.Module(read('kernel/katybug.wasm')));
const scratch = mkdtempSync(join(tmpdir(), 'gmux-probes-'));
const program = (name: string) =>
	probes[name]!.program === null ? null : (probes[name]!.program ?? `probes/${name}.wasm`);
// [path in the machine, path under build/, probe]
const added = names.flatMap((name): [string, string, string][] => [
	...(program(name) === null
		? []
		: [[`/bin/${name}`, program(name)!, name] as [string, string, string]]),
	...Object.entries(probes[name]!.programs ?? {}).map(([to, from]): [string, string, string] => [
		to,
		from,
		name
	])
]);
for (const [to, path, name] of added) {
	// the kernel reads the plain file; the host runs the fueled module registered under its hash
	const fueled = join(scratch, `${to.replace(/\W/g, '_')}.wasm`);
	execFileSync(join(root, 'scripts/wasm/instrument.sh'), [join(build, path), fueled]);
	let runs = fueled;
	const forks = probes[name]!.evacuate;
	const evacuated = Array.isArray(forks) ? forks.includes(to) : !!forks;
	if (evacuated) {
		execFileSync(
			join(root, 'scripts/ts'),
			[join(root, 'scripts/wasm/export-globals.ts'), fueled, `${fueled}.g`, '--all-mutable'],
			{
				stdio: 'ignore'
			}
		);
		execFileSync(
			process.execPath,
			[
				join(root, 'experiments/evacuation/scripts/evacuate.ts'),
				`${fueled}.g`,
				`${fueled}.evac`,
				process.env.GMUX_EVACUATE ?? '--resume'
			],
			{ stdio: 'ignore' }
		);
		runs = `${fueled}.evac`;
	}
	if (share && !evacuated) {
		// share.ts refuses programs that call dlopen, and a forking program's frames are its own
		// instance's; those keep an instance each
		try {
			execFileSync(
				join(root, 'scripts/ts'),
				[join(root, 'scripts/wasm/share.ts'), join(build, path), fueled, `${fueled}.share`],
				{ stdio: 'ignore' }
			);
			runs = `${fueled}.share`;
		} catch {}
	}
	registry.set(sha256(read(path)), new WebAssembly.Module(readFileSync(runs)));
}
for (const path of sideModules(names.flatMap((name) => probes[name]!.side ?? []))) {
	const fueled = join(scratch, `${path.replace(/\W/g, '_')}.wasm`);
	execFileSync(join(root, 'scripts/wasm/instrument.sh'), [join(build, path), fueled]);
	registry.set(sha256(read(path)), new WebAssembly.Module(readFileSync(fueled)));
}
// the guarded builds a non-root task runs (scripts/wasm/guard-pass.ts), for the isolation probe
const guarded = new Map<string, WebAssembly.Module>();
if (names.includes('isolation')) {
	const plain = join(build, program('isolation')!);
	const wat = join(scratch, 'isolation.wat');
	execFileSync('wasm2wat', [
		'--enable-threads',
		'--enable-exceptions',
		'--generate-names',
		plain,
		'-o',
		wat
	]);
	execFileSync(
		join(root, 'scripts/ts'),
		[join(root, 'scripts/wasm/guard-pass.ts'), wat, `${wat}.guard`, '--inline'],
		{ stdio: 'ignore' }
	);
	execFileSync('wat2wasm', [
		'--enable-threads',
		'--enable-exceptions',
		'--enable-multi-memory',
		`${wat}.guard`,
		'-o',
		join(scratch, 'isolation.guard.wasm')
	]);
	execFileSync(join(root, 'scripts/wasm/instrument.sh'), [
		join(scratch, 'isolation.guard.wasm'),
		join(scratch, 'isolation.guard.fuel.wasm')
	]);
	guarded.set(
		sha256(read(program('isolation')!)),
		new WebAssembly.Module(readFileSync(join(scratch, 'isolation.guard.fuel.wasm')))
	);
}
const initrd = join(scratch, 'initramfs.cpio');
appendCpio(join(build, 'kernel/initramfs.bin'), initrd, [
	...added.map(([to, path]) => `${to}=${join(build, path)}`),
	...names.flatMap(fileEntries)
]);

// one line per probe: the tty cuts a canonical line at 4095 bytes; stdin stays off the typed lines
async function boot(group: string[], maximumPages: number) {
	const script = group
		.map(
			(name) =>
				`{ ${probes[name]!.setup ? `${probes[name]!.setup}; ` : ''}echo "== ${name}"; ${probes[name]!.cmd ?? name}; echo "== end $?"; } < /dev/null`
		)
		.join('\n');
	let output = '';
	const hostLog: string[] = [];
	let typed = false;
	const machine = new Machine({
		vmlinux: new WebAssembly.Module(read('kernel/vmlinux.wasm')),
		initrd: new Uint8Array(readFileSync(initrd)),
		cmdline: 'maxcpus=3 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0',
		registry,
		maximumPages,
		sha256,
		sharedKernel: true,
		shareInstances: share,
		guarded,
		// FROZEN=1: a host clock that never moves, as a deployed Worker's while code runs
		...(process.env.FROZEN ? { now: () => 0n } : {}),
		log: (line) => hostLog.push(line),
		write: (text) => {
			output += text;
			if (!typed && output.includes('# ')) {
				typed = true;
				machine.type(`${script}\necho "== DONE-$((6*7))"\n`);
			}
		}
	});
	const started = Date.now();
	await machine.run(
		() => output.includes('== DONE-42') || Date.now() - started > 120_000,
		(ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50)))
	);
	return { machine, output, hostLog };
}
const authority = names.includes('authority');
const planted = authority ? await hostOnly() : [];
const seen = authority ? watch() : null;
const shared = names.filter((name) => !probes[name]!.pages);
const own = names.filter((name) => probes[name]!.pages);
const boots = new Map<string, Awaited<ReturnType<typeof boot>>>();
if (shared.length) {
	const main = await boot(shared, 4096);
	for (const name of shared) boots.set(name, main);
}
for (const name of own) boots.set(name, await boot([name], probes[name]!.pages!));
const machine = [...boots.values()].at(-1)!.machine;
const mainMachine = shared.length ? boots.get(shared[0]!)!.machine : machine;

seen?.stop();
const hostSide: string[] = [];
if (seen) {
	const buffers = [...new Set([mainMachine.memory, ...seen.memories])].map((m) => m.buffer);
	const bytes = buffers.reduce((n, b) => n + b.byteLength, 0);
	const off = [...seen.imports].filter((i) => !SURFACE.test(i));
	hostSide.push(...leaks(planted, buffers).map((l) => `host-only ${l}`));
	// the host did put the command line there, so a scan that misses it is broken
	if (!leaks(['rootfstype=ramfs'], buffers).length)
		hostSide.push('the host scan misses the command line');
	hostSide.push(...off.map((i) => `import ${i} is off the surface`));
	console.log(
		`host: ${planted.length} host-only values searched in ${buffers.length} guest memories ` +
			`(${bytes} bytes): ${hostSide.length ? 'found' : 'absent'}; ${seen.imports.size} imports, ` +
			`${off.length} off the surface`
	);
}

let failed = 0;
for (const name of names) {
	const { output, hostLog } = boots.get(name)!;
	const at = output.lastIndexOf(`\n== ${name}`);
	const section = at < 0 ? '' : output.slice(at, output.indexOf('== end', at));
	const { lines, passes = 0, host } = probes[name]!;
	const problems = [
		...(name === 'authority' ? hostSide : []),
		...(host && !hostLog.some((line) => line.includes(host))
			? [`host never logged "${host}"`]
			: []),
		...lines.filter((line) => !section.includes(line)).map((line) => `missing "${line}"`),
		...(section.match(/^FAIL .*/gm) ?? []).map((line) => line.trim()),
		...((section.match(/^PASS /gm) ?? []).length !== passes
			? [`expected ${passes} PASS lines`]
			: [])
	];
	if (at < 0) problems.unshift('did not run');
	if (problems.length) failed++;
	console.log(problems.length ? 'FAIL' : 'PASS', name.padEnd(10), problems.join('; '));
	if (problems.length) console.log(section.slice(-1200).replace(/\r/g, ''));
	if (process.env.SHOW) console.log(section.replace(/\r/g, ''));
	if (problems.length && process.env.HOSTLOG) console.log(hostLog.slice(-20).join('\n'));
}
if (process.env.STATS) console.log(JSON.stringify(machine.stats));
process.exit(failed ? 1 : 0);
