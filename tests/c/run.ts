import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { concat, sections, text } from '../../scripts/wasm/binary.ts';
import { appendCpio } from '../../scripts/wasm/cpio-append.ts';
import { inputs } from '../../scripts/wasm/inputs.ts';
import { hostRuntime } from '../../scripts/wasm/router-modules.ts';
import { Machine } from '../../src/worker/machine/machine.ts';
import { hostOnly, leaks, SURFACE, watch } from './authority.ts';

/**
 * Boots build/kernel with the tests/c probes from build/probes and checks each one's output;
 * GMUX_BUILD points at another build, FROZEN=1 stops the host clock. The scheduler core from
 * build/router runs the scheduler's tables in C; CORE=0 runs them in TypeScript and
 * CORE=<gmux-core.wasm> runs another core build.
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
	/** the machine's `maxcpus=`: a probe that sets it boots a machine of its own */
	maxcpus?: number;
	/** problems the host finds in the probe's output, beyond its lines and PASS count */
	check?: (section: string) => string[];
}

/**
 * tests/c/gens.c prints a STEP line per call: a changed hash with a counter that did not move is a
 * missing bump, and each class needs a change that moved its counter or the corpus proves nothing
 */
function gensCheck(section: string): string[] {
	const classes = ['fd', 'cred', 'mm', 'sig'];
	const bumps = classes.map(() => 0);
	const falses = classes.map(() => 0);
	const problems: string[] = [];
	let steps = 0;
	for (const step of section.matchAll(/^STEP (\w+) (\S+)(.*)$/gm)) {
		steps++;
		for (const [, name, h, g] of step[3]!.matchAll(/(\w+):([h-])([g-])/g)) {
			const at = classes.indexOf(name!);
			if (h === 'h' && g === 'g') bumps[at] = bumps[at]! + 1;
			if (h === '-' && g === 'g') falses[at] = falses[at]! + 1;
			if (h === 'h' && g === '-')
				problems.push(`missing ${name} bump after ${step[2]} (${step[1]})`);
		}
	}
	classes.forEach((name, i) => bumps[i] || problems.push(`no step changed the ${name} state`));
	if (
		!WebAssembly.Module.exports(new WebAssembly.Module(read('kernel/vmlinux.wasm'))).some(
			(e) => e.name === 'wasm_current_gens'
		)
	)
		problems.push('the kernel does not export wasm_current_gens');
	console.log(
		`gens: ${steps} steps; counter moved with a change ${bumps.join('/')}, without one ${falses.join('/')} (fd/cred/mm/sig)`
	);
	return problems;
}

/**
 * 8 `sleep 1` and a busy loop on one cpu (the `timers` probe): each sleeper's end-to-end time from
 * /proc/uptime, which has 10 ms steps; the lateness is that time less the second asked for. The
 * bound is the latest sleeper of the same probe on a kernel where the busy task has a cpu to itself
 * (192 sleepers over 8 runs in each of normal, FROZEN and SHARE: 30 ms)
 */
const TIMERS_LATE_MS = 30;
function timersCheck(section: string): string[] {
	const late = [...section.matchAll(/^SLEEP \d+ (\d+\.\d+) (\d+\.\d+)$/gm)]
		.map((m) => Math.round((Number(m[2]) - Number(m[1]) - 1) * 100) * 10)
		.sort((a, b) => a - b);
	// field 39 of /proc/<pid>/stat is the cpu the task last ran on
	const cpu = (line: string) => line.slice(line.lastIndexOf(')') + 2).split(' ')[36];
	const busy = section.match(/^BUSY (.*)$/m);
	const asleep = [...section.matchAll(/^SLEEPING (.*)$/gm)].map((m) => cpu(m[1]!));
	const problems: string[] = [];
	if (late.length !== 8) problems.push(`${late.length} of 8 sleepers finished`);
	if (late.at(-1)! > TIMERS_LATE_MS) problems.push(`a sleeper was ${late.at(-1)} ms late`);
	if (!busy || !asleep.length || asleep.some((c) => c !== cpu(busy[1]!)))
		problems.push('the sleepers and the busy task are not on one cpu');
	console.log(
		`timers: lateness ms ${late.join(' ')}; ${asleep.length} sleepers seen on cpu ${asleep[0]}`
	);
	return problems;
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
	// 128 KiB in a mapping of its own, the arguments in another, and a 122 KiB frame on it with no
	// host segment; caught at the stack's own bound, not by running off the end of memory
	stack: { lines: [], passes: 5, host: 'fault: stack overflow' },
	time: { lines: [], passes: 5 },
	// a nommu mremap keeps the mapping tree's range in step with the VMA, and 100,000 mmap/munmap
	// pairs leave no pile of slab behind an RCU grace period, in the memory a Free isolate holds
	maps: { lines: [], pages: 800, passes: 12 },
	// the kernel's generation counters (patch 0030) against the state they guard, after each call of a
	// scripted sequence in this task, a thread, a fork child and an exec
	gens: { evacuate: true, lines: ['SUMMARY'], passes: 9, check: gensCheck },
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
			'/bin/sqlite3': 'katybug/transcript/ubin/sqlite3',
			'/bin/busybox-static': 'katybug/transcript/busybox'
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
	// katybug ran musl's exp, log and pow (a static Alpine busybox's awk) as host kernels, found by their
	// code; the digits are the native run's. A line typed past about 1,020 bytes is cut, so this is not
	// part of userland's
	libm: {
		program: null,
		files: { '/bin/busybox-static': 'katybug/transcript/busybox' },
		cmd:
			'KATYBUG_STATS=1 KATYBUG_PRIM_LOG=/tmp/pm busybox-static awk \'BEGIN { printf "%.17g %.17g %.17g\\n", exp(1.5), log(10), 2^0.5 }\'; ' +
			'echo "prim libm kernels $(grep -c \'prim.* exp [1-9].* log [1-9].* pow [1-9]\' /tmp/pm)"',
		lines: ['4.4816890703380645 2.3025850929940459 1.4142135623730951', 'prim libm kernels 1']
	},
	// katybug ran crc32, adler32, compress2 and uncompress of a dynamic amd64 program over Alpine's libz
	// (experiments/library-thunks/scripts/zlib-guest.sh stages it) as host kernels, over the zlib built into
	// katybug.wasm; the sums are the native run's
	zlib: {
		program: null,
		files: {
			'/lib/ld-musl-x86_64.so.1': 'katybug/zlib/ld-musl-x86_64.so.1',
			'/lib/libz.so.1': 'katybug/zlib/libz.so.1',
			'/bin/zbench': 'katybug/zlib/zbench'
		},
		cmd:
			'zbench corpus /tmp/c; export KATYBUG_STATS=1 KATYBUG_PRIM_LOG=/tmp/pz; ' +
			'zbench run crc 2 /tmp/c; zbench run adl 2 /tmp/c; zbench run def 1 /tmp/c; zbench run inf 1 /tmp/c; ' +
			"echo \"prim zlib kernels $(grep -c ' crc32 [1-9]' /tmp/pz) $(grep -c ' adler32 [1-9]' /tmp/pz) " +
			"$(grep -c ' compress2 [1-9]' /tmp/pz) $(grep -c ' uncompress [1-9]' /tmp/pz)\"",
		lines: [
			'crc 2 3327425700',
			'adl 2 7114156529',
			'def 1 398521',
			'inf 1 1048784',
			'prim zlib kernels 1 1 4 1'
		]
	},
	// the stream entries (deflateInit_ to inflateCodesUsed) of the same program over a guest z_stream: each mode's
	// output (checksum and length) is the native run's, and a stream open across the machine's fork (which sends
	// guest memory only) fails in the child's libz with Z_STREAM_ERROR
	zstream: {
		program: null,
		files: {
			'/lib/ld-musl-x86_64.so.1': 'katybug/zlib/ld-musl-x86_64.so.1',
			'/lib/libz.so.1': 'katybug/zlib/libz.so.1',
			'/bin/zbench': 'katybug/zlib/zbench'
		},
		cmd:
			'export KATYBUG_STATS=1 KATYBUG_PRIM_LOG=/tmp/pz; ' +
			'for m in stream-misc alloc fault fork; do zbench $m | cksum; done; zbench gzrun cd 2 6 4096; ' +
			"echo \"prim zstream kernels $(grep -c ' deflate [1-9]' /tmp/pz) $(grep -c ' inflate [1-9]' /tmp/pz) " +
			"$(grep -c 'zstream lost [1-9]' /tmp/pz)\"",
		lines: [
			'3923843301 2297457',
			'993302787 349',
			'315487918 652',
			'4270157107 438',
			'gzrun cd mib 2 level 6 chunk 4096 in 2097152 out 753028 crc_in 73213365 crc_out ddf25199 back 2097152 crc_back 73213365 rc 1 same 1',
			'prim zstream kernels 6 3 1'
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
	// BusyBox httpd serves a static file and a CGI script over lo to wget; the host's stream relay
	// reaches the same listener (experiments/serving, tests/unit/machine.test.ts)
	serve: {
		program: null,
		cmd:
			'mkdir -p /www/cgi-bin; echo served-$((6*7)) > /www/n.txt; ' +
			"printf '#!/bin/sh\\necho Content-Type: text/plain\\necho\\necho cgi-served-%s\\n' $((6*7)) > /www/cgi-bin/hi.cgi; " +
			'chmod +x /www/cgi-bin/hi.cgi; httpd -p 8081 -h /www; sleep 1; ' +
			'wget -q -O - http://127.0.0.1:8081/n.txt; wget -q -O - http://127.0.0.1:8081/cgi-bin/hi.cgi; ' +
			'wget -q -O /dev/null http://127.0.0.1:8081/missing || echo "missing rc $?"',
		lines: ['served-42', 'cgi-served-42', 'missing rc 1']
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
		passes: 26
	},
	// sendfile and splice from a file to a socket over lo, to a forked receiver that hashes what arrives;
	// the lines are the native build's output on x86-64 Linux
	sendfile: {
		setup: 'ifconfig lo 127.0.0.1 up',
		evacuate: true,
		lines: [
			'sendfile with an offset: 1048576 bytes, fnv 720170d29ea12e6e, offset 1048576, position 0',
			'sendfile on the file position: 1048576 bytes, fnv 720170d29ea12e6e, offset -1, position 1048576',
			'sendfile of a range: 70000 bytes, fnv cde816ca3d36219d, offset 82345, position 0',
			'sendfile of more than is left: 48576 bytes, fnv 2abd2d4bfaeba3fb, offset 1048576, position 0',
			'splice file to pipe to socket: 1048576 bytes, fnv 720170d29ea12e6e, offset 1048576, position 0',
			'splice of a range: 70000 bytes, fnv cde816ca3d36219d, offset 82345, position 0',
			'read and write: 1048576 bytes, fnv 720170d29ea12e6e, offset 1048576, position 0',
			'sendfile to a bad descriptor: -1 errno 9',
			'sendfile from a socket: -1 errno 107',
			'sendfile of no bytes: 0; past the end: 0'
		],
		passes: 10
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
		passes: 30
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
	// a coreutils run's link loop does; each exec maps a stack of 32 pages, a page of arguments and a
	// data block of its own, and blocks of 64 pages must still be free after them. Then every way an
	// exec can fail (missing path, a directory, no permission, a shebang to a missing interpreter, a
	// long path, a program the host refuses, ETXTBSY, an argument too long) returns its errno, an
	// x86-64 ELF still runs through katybug, and 1,200 failures leave no pages behind
	exec: {
		program: null,
		pages: 800,
		programs: { '/bin/execfail': 'probes/execfail.wasm' },
		files: { '/bin/hello-x86': 'katybug/hello-x86' },
		setup: 'dd if=/dev/zero of=/tmp/fill bs=1M count=10 2> /dev/null',
		cmd:
			'i=0; n=0; while [ $i -lt 106 ]; do ln -s x /tmp/l$i && n=$((n+1)); i=$((i+1)); done; ' +
			'echo "linked $n"; ' +
			'awk \'{ for (i = 11; i <= 19; i++) if ($i > 0) big += $i } END { print big ? "order 6 free" : "no order 6" }\' /proc/buddyinfo; ' +
			'execfail',
		lines: [
			'linked 106',
			'order 6 free',
			'missing file -> 2',
			'a directory -> 13',
			'shebang to a missing interpreter -> 2',
			'not a program -> 8',
			'a path of 4999 bytes -> 36',
			'busy for writing -> 26',
			'the host refuses it -> 211',
			'an argument of 139999 bytes -> 7',
			'x86-64 through katybug -> 0',
			'300 rounds of four failures: 0 wrong,'
		],
		passes: 17
	},
	// a program without the stack abi word (abi-old: abi with its gmux.abi section cut out, so a build
	// from before the word) fails its exec with EPROTO and one console line, and an 800-page machine
	// runs 200 refusals, each followed by an exec
	abi: {
		pages: 800,
		programs: { '/bin/abi-old': 'probes/abi-old.wasm' },
		cmd: 'abi; /bin/abi-old child; echo "shell rc $?"',
		lines: [
			'exec /bin/abi-old: it is built for stack ABI 0 (0: built before the word), this kernel runs 1; rebuild it',
			"sh: can't execute '/bin/abi-old': Protocol error",
			'shell rc 2'
		],
		passes: 5
	},
	// user tasks share the cpus (patch 0032): 256 tasks each blocked opening a fifo are all alive at
	// once, as /proc counts them, and exit when it is written
	tasks: {
		program: null,
		pages: 4096,
		cmd:
			'mkdir -p /tasks; mkfifo /tasks/go; i=0; ' +
			'{ while [ $i -lt 256 ]; do cat /tasks/go > /dev/null & i=$((i+1)); done; } 2> /tasks/err; ' +
			'count() { n=0; for d in /proc/[0-9]*; do read c < $d/comm; [ "$c" = cat ] && n=$((n+1)); done; }; ' +
			'k=0; count; while [ $n -lt 256 ] && [ $k -lt 50 ]; do sleep 0.1; count; k=$((k+1)); done; ' +
			'[ $n -eq 256 ] && echo "PASS 256 tasks alive" || echo "FAIL $n tasks alive"; ' +
			'[ -s /tasks/err ] && echo "FAIL vfork: $(head -n 1 /tasks/err)" || echo "PASS no vfork failure"; ' +
			'grep MemFree /proc/meminfo; echo x > /tasks/go; wait; ' +
			'[ $? -eq 0 ] && echo "PASS wait returned" || echo "FAIL wait"',
		lines: [],
		passes: 3
	},
	// a thread cannot change its affinity; a program may set a mask of several cpus and exit (the
	// kernel once panicked in release_thread)
	affinity: { cmd: 'affinity; echo "affinity rc $?"', lines: ['affinity rc 0'], passes: 5 },
	// sleepers and a busy task on the one user cpu (maxcpus=2: the interrupt cpu and one more): each
	// sleeper's timer fires when the busy task next yields in user mode
	timers: {
		program: null,
		maxcpus: 2,
		cmd:
			'mkdir -p /tm; { while :; do :; done; } & b=$!; ' +
			'for i in 1 2 3 4 5 6 7 8; do ' +
			'( read a _ < /proc/uptime; sleep 1; read e _ < /proc/uptime; echo "SLEEP $i $a $e" ) > /tm/s$i & done; ' +
			'sleep 0.5; echo "BUSY $(cat /proc/$b/stat)"; ' +
			'for f in /proc/[0-9]*/stat; do { read -r l < $f; } 2> /dev/null; case $l in *"(sleep)"*) echo "SLEEPING $l";; esac; done; ' +
			'sleep 1.5; kill $b; wait; cat /tm/s*',
		lines: [],
		check: timersCheck
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
// RECYCLE=1: the same share builds, each process on an instance of its own that a finished one hands on
const recycle = !!process.env.RECYCLE;
const busybox = read(share || recycle ? 'kernel/busybox.share.wasm' : 'kernel/busybox.wasm');
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
if (names.includes('abi')) {
	const whole = read('probes/abi.wasm');
	const kept = [whole.subarray(0, 8)];
	for (const [id, start, body, end] of sections(whole))
		if (id !== 0 || text.decode(whole.subarray(body + 1, body + 9)) !== 'gmux.abi')
			kept.push(whole.subarray(start, end));
	writeFileSync(join(build, 'probes/abi-old.wasm'), concat(kept));
}
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
	if ((share || recycle) && !evacuated) {
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
// (stty -echo: input that reaches the tty while a probe runs is echoed into the probe's output)
async function boot(group: string[], maximumPages: number, maxcpus = 3) {
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
		cmdline: `maxcpus=${maxcpus} root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0`,
		registry,
		maximumPages,
		sha256,
		sharedKernel: true,
		shareInstances: share,
		guarded,
		// FROZEN=1: a host clock that never moves, as a deployed Worker's while code runs
		...(process.env.FROZEN ? { now: () => 0n } : {}),
		runtime: {
			...hostRuntime(join(root, 'build/router'), { core: !process.env.CORE }),
			...(process.env.CORE && process.env.CORE !== '0'
				? { core: new WebAssembly.Module(readFileSync(process.env.CORE)) }
				: {})
		},
		log: (line) => hostLog.push(line),
		write: (text) => {
			output += text;
			if (!typed && output.includes('# ')) {
				typed = true;
				machine.type(`stty -echo\n${script}\necho "== DONE-$((6*7))"\n`);
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
const shared = names.filter((name) => !probes[name]!.pages && !probes[name]!.maxcpus);
const own = names.filter((name) => probes[name]!.pages || probes[name]!.maxcpus);
const boots = new Map<string, Awaited<ReturnType<typeof boot>>>();
if (shared.length) {
	const main = await boot(shared, 4096);
	for (const name of shared) boots.set(name, main);
}
for (const name of own)
	boots.set(name, await boot([name], probes[name]!.pages ?? 4096, probes[name]!.maxcpus));
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
	const at = output.lastIndexOf(`== ${name}\r\n`);
	const section = at < 0 ? '' : output.slice(at, output.indexOf('== end', at));
	const { lines, passes = 0, host } = probes[name]!;
	const problems = [
		...(name === 'authority' ? hostSide : []),
		...(probes[name]!.check?.(section) ?? []),
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
