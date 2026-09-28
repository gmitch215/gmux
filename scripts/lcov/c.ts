import { execFileSync, spawnSync } from 'node:child_process';
import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { dirname, join } from 'node:path';
import { formatLcov, parseLcov, repoPath, report, type FileCoverage } from './lcov.ts';

/**
 * The `c` flag: Katybug built with clang's source-based coverage, run over its corpora (run.sh and
 * wasm-ops.sh whole, the x86 and AArch64 instruction corpora on Katybug's side, checked against a
 * native run when this host can make one or one is stored), merged with llvm-profdata and exported
 * by llvm-cov as lcov with repo-relative paths. The corpus scripts call `cc`, so a shim directory
 * puts the same clang first on PATH and KATYBUG_CFLAGS adds the instrumentation to their builds.
 * `scripts/lcov/c.ts [--out coverage/c.info]`; LLVM names the toolchain's bin directory,
 * X86_OPS_NATIVE and A64_OPS_NATIVE a stored native run of either corpus
 */
const root = join(import.meta.dirname, '../..');
const args = process.argv.slice(2);
const at = args.indexOf('--out');
const outFile = join(root, at >= 0 ? args[at + 1]! : 'coverage/c.info');
// a directory per run, so a report describes this run only (older counts would merge in silently)
const work = join(root, 'build/coverage/c', new Date().toISOString().replace(/[:.]/g, '-'));
const prof = join(work, 'prof');
const kb = join(root, 'tests/c/katybug');
const ts = join(root, 'scripts/ts');

function llvmDir(): string {
	if (process.env.LLVM) return process.env.LLVM;
	if (existsSync('/opt/homebrew/opt/llvm/bin/clang')) return '/opt/homebrew/opt/llvm/bin';
	// a distribution's clang is a link into its versioned toolchain, where llvm-cov sits beside it
	return dirname(realpathSync(execFileSync('which', ['clang'], { encoding: 'utf8' }).trim()));
}
const llvm = llvmDir();
const clang = join(llvm, 'clang');
// the profile path is built in, since the transcripts run each line under env -i
const FLAGS = [`-fprofile-instr-generate=${prof}/%p.profraw`, '-fcoverage-mapping'];

mkdirSync(prof, { recursive: true });
mkdirSync(join(work, 'bin'));
symlinkSync(clang, join(work, 'bin/cc'));
const env = {
	...process.env,
	PATH: `${join(work, 'bin')}:${process.env.PATH}`,
	LLVM: llvm,
	KATYBUG_CFLAGS: FLAGS.join(' ')
};

const results: [string, string][] = [];
function step(name: string, cmd: string, argv: string[], opts: { stdout?: string } = {}) {
	const r = spawnSync(cmd, argv, { cwd: root, env, encoding: 'buffer', maxBuffer: 1 << 30 });
	if (opts.stdout) writeFileSync(opts.stdout, r.stdout);
	const tail = r.stdout.toString('utf8').trim().split('\n').at(-1) ?? '';
	const status = r.status === 0 ? 'ok' : `exit ${r.status ?? r.signal}`;
	results.push([name, `${status}; ${opts.stdout ? '' : tail}`.replace(/; $/, '')]);
	if (r.status !== 0 && !opts.stdout) process.stderr.write(r.stderr);
	return r.status === 0;
}

const katybug = join(work, 'katybug');
execFileSync(clang, [
	'-std=c11',
	'-D_DEFAULT_SOURCE',
	'-D_DARWIN_C_SOURCE',
	'-O2',
	...FLAGS,
	'-o',
	katybug,
	...readdirSync(join(root, 'src/gmux/katybug'))
		.filter((f) => f.endsWith('.c'))
		.map((f) => join(root, 'src/gmux/katybug', f)),
	'-lm'
]);

step('run.sh', 'bash', [join(kb, 'run.sh')]);
step('wasm-ops.sh', 'bash', [join(kb, 'wasm-ops.sh')]);

/** a corpus on Katybug's side, and against a native run when there is one */
function corpus(name: string, target: string, native: () => string | null, diff: string[]) {
	const asm = join(work, `${name}.S`);
	const elf = join(work, name);
	writeFileSync(asm, execFileSync(ts, [join(kb, `${name}.ts`)], { maxBuffer: 1 << 30 }));
	execFileSync(clang, [
		`--target=${target}`,
		'-nostdlib',
		'-static',
		'-fuse-ld=lld',
		'-o',
		elf,
		asm
	]);
	const out = join(work, `${name}.katybug.bin`);
	step(`${name} (katybug)`, katybug, [elf], { stdout: out });
	const ref = native();
	if (!ref) return results.push([`${name} (diff)`, 'no native run on this host; not compared']);
	step(`${name} (diff)`, ts, [join(kb, 'x86-ops-diff.ts'), asm, ref, out, ...diff]);
}
const host = `${process.platform}-${process.arch}`;
const stored = (v: string | undefined) => (v && existsSync(v) ? v : null);
corpus(
	'x86-ops',
	'x86_64-linux-gnu',
	() => {
		if (host !== 'linux-x64') return stored(process.env.X86_OPS_NATIVE);
		// this CPU may lack an extension the corpus uses
		const run = spawnSync(join(work, 'x86-ops'), { maxBuffer: 1 << 30 });
		if (run.status !== 0) return stored(process.env.X86_OPS_NATIVE);
		const ref = join(work, 'x86-ops.native.bin');
		writeFileSync(ref, run.stdout);
		return ref;
	},
	[]
);
corpus(
	'a64-ops',
	'aarch64-linux-gnu',
	() => {
		const ref = join(work, 'a64-ops.native.bin');
		const run =
			host === 'linux-arm64'
				? spawnSync(join(work, 'a64-ops'), { maxBuffer: 1 << 30 })
				: spawnSync(
						'docker',
						[
							'run',
							'--rm',
							'--platform',
							'linux/arm64',
							'--memory',
							'512m',
							'--cpus',
							'2',
							'-v',
							`${work}:/k:ro`,
							'alpine:3.20',
							'/k/a64-ops'
						],
						{ maxBuffer: 1 << 30 }
					);
		if (run.status !== 0) return stored(process.env.A64_OPS_NATIVE);
		writeFileSync(ref, run.stdout);
		return ref;
	},
	['--a64']
);

// the transcripts transcript.sh keeps under build/katybug, against their stored native runs
for (const dir of ['transcript', 'transcript-aarch64']) {
	const src = join(root, 'build/katybug', dir);
	if (!existsSync(join(src, 'run.sh'))) {
		results.push([dir, 'not kept on this host (tests/c/katybug/transcript.sh); skipped']);
		continue;
	}
	const t = join(work, dir);
	cpSync(src, t, { recursive: true });
	mkdirSync(join(t, 'bin'), { recursive: true });
	if (existsSync(join(t, 'ubin.list')))
		for (const name of readFileSync(join(t, 'ubin.list'), 'utf8').split('\n').filter(Boolean))
			if (!existsSync(join(t, 'ubin', name))) symlinkSync('coreutils', join(t, 'ubin', name));
	for (const suite of ['busybox', 'userland']) {
		if (!existsSync(join(t, `${suite}.native.txt`))) continue;
		if (suite === 'userland' && !existsSync(join(t, 'ubin/coreutils'))) continue;
		const tmp = join(work, `tmp-${dir}-${suite}`);
		const got = join(work, `${dir}-${suite}.katybug.txt`);
		mkdirSync(tmp);
		const r = spawnSync(
			'perl',
			['-e', '$SIG{PIPE} = "DEFAULT"; exec @ARGV or die', join(t, 'run.sh'), suite, katybug],
			{ env: { ...env, TMPDIR: tmp }, maxBuffer: 1 << 30 }
		);
		// the profile runtime puts this in the environment a guest's env prints
		writeFileSync(
			got,
			r.stdout
				.toString('utf8')
				.replaceAll('__LLVM_PROFILE_RT_INIT_ONCE=__LLVM_PROFILE_RT_INIT_ONCE\n', '')
		);
		step(`${dir} ${suite}`, ts, [
			join(kb, 'transcript-diff.ts'),
			join(t, `${suite}.native.txt`),
			got
		]);
	}
}

const raws = readdirSync(prof).filter((f) => f.endsWith('.profraw'));
const data = join(work, 'c.profdata');
execFileSync(join(llvm, 'llvm-profdata'), [
	'merge',
	'-sparse',
	'-o',
	data,
	...raws.map((f) => join(prof, f))
]);
const exported = execFileSync(
	join(llvm, 'llvm-cov'),
	['export', '-format=lcov', `-instr-profile=${data}`, katybug],
	{ encoding: 'utf8', maxBuffer: 1 << 30 }
);
const files: FileCoverage[] = [];
for (const f of parseLcov(exported)) {
	const file = repoPath(root, f.file);
	if (file?.startsWith('src/gmux/')) files.push({ ...f, file });
}
const lcov = formatLcov(files);
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, lcov);
for (const [name, r] of results) console.log(`${name}: ${r}`);
console.log(`${raws.length} profiles merged`);
process.exit(report('coverage c', lcov));
