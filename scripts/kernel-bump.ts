import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * The deterministic half of a kernel base bump. `kernel-bump.ts check --target <tag|latest-stable|
 * latest-mainline> [--work <dir>] [--json] [--exclude-patch <nnnn>] [--fork-remote <url>]
 * [--tag-remote <url>] [--sources <file>] [--patches <dir>] [--releases <url|file>]` fetches the
 * pinned fork commit, the base tag and the target tag at depth 1 into <work> (default $KERNEL_BUMP_DIR,
 * else a temp directory), builds the fork plus src/kernel/patches without a worktree, and merges the
 * fork alone and the patched fork into the target on the base tag. Resolving conflicts and fixing
 * compile errors stay with a person; the report ends with the commands for that. Exit 0 merges
 * clean, 1 conflicts, 2 error.
 */
export const STABLE = 'https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git';
export const MAINLINE = 'https://github.com/torvalds/linux.git';
export const RELEASES = 'https://www.kernel.org/releases.json';

export class BumpError extends Error {}

// #region pure functions

export function parseMergeTree(out: string) {
	const lines = out.split('\n');
	const blank = lines.indexOf('', 1);
	const paths = [...new Set(lines.slice(1, blank < 0 ? lines.length : blank).filter(Boolean))];
	const messages = blank < 0 ? [] : lines.slice(blank + 1);
	const other = messages.filter(
		(l) => l.startsWith('CONFLICT (') && !l.startsWith('CONFLICT (content)')
	);
	return { tree: lines[0] ?? '', paths, other };
}

export const countHunks = (blob: string) =>
	blob.split('\n').filter((l) => l.startsWith('<<<<<<< ')).length;

export function classify(path: string, absentAtBase: boolean): 'port' | 'core' {
	return path.startsWith('arch/wasm/') || absentAtBase ? 'port' : 'core';
}

export const patchNumber = (file: string) => /^(\d+)-/.exec(file)?.[1] ?? file;

export function parseNumstat(text: string): string[] {
	const paths: string[] = [];
	for (const line of text.split('\n')) {
		const path = line.split('\t')[2];
		if (path) paths.push(path);
	}
	return [...new Set(paths)];
}

export function pathPatches(byPatch: Record<string, string[]>): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	for (const [patch, paths] of Object.entries(byPatch))
		for (const path of paths) (out[path] ??= []).push(patch);
	for (const list of Object.values(out)) list.sort();
	return out;
}

export interface Shortstat {
	files: number;
	insertions: number;
	deletions: number;
}

export function parseShortstat(text: string): Shortstat {
	const n = (word: string) => Number(new RegExp(`(\\d+) ${word}`).exec(text)?.[1] ?? 0);
	return { files: n('file'), insertions: n('insertion'), deletions: n('deletion') };
}

export function pickRelease(releases: unknown, which: string): string {
	const json = releases as {
		latest_stable?: { version?: string };
		releases?: { moniker: string; version: string }[];
	};
	const version =
		which === 'latest-stable'
			? json.latest_stable?.version
			: json.releases?.find((r) => r.moniker === 'mainline')?.version;
	if (!version) throw new BumpError(`releases.json has no ${which}`);
	return `v${version}`;
}

export function selectPatches(files: string[], exclude: string[]) {
	const drop = new Set(exclude.map((n) => n.padStart(4, '0')));
	const known = new Set(files.map(patchNumber));
	for (const n of drop) if (!known.has(n)) throw new BumpError(`no patch ${n} to exclude`);
	return {
		applied: files.filter((f) => !drop.has(patchNumber(f))),
		excluded: files.filter((f) => drop.has(patchNumber(f)))
	};
}

export interface Conflict {
	path: string;
	hunks: number;
	side: 'port' | 'core';
	patches: string[];
}

export interface MergeResult {
	name: 'fork' | 'patched';
	exit: number;
	tree: string;
	conflicts: Conflict[];
	other: string[];
}

export interface Report {
	base: { ref: string; commit: string };
	target: { ref: string; commit: string; remote: string };
	fork: { commit: string; remote: string };
	patched: { commit: string; tree: string };
	patches: { applied: string[]; excluded: string[]; upstream: string[] };
	merges: MergeResult[];
	drift: Shortstat;
	changedClean: string[];
	work: string;
	summary: string;
	next: string[];
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const num = (n: number) => n.toLocaleString('en-US');
const share = (m: MergeResult, side: string) => m.conflicts.filter((c) => c.side === side).length;

export function summarize(r: Pick<Report, 'target' | 'merges' | 'patches' | 'drift'>): string {
	const part = (m: MergeResult) =>
		m.conflicts.length === 0 && m.other.length === 0
			? `${m.name} clean`
			: `${m.name} ${plural(m.conflicts.length, 'conflicted path')} ` +
				`(port ${share(m, 'port')}, core ${share(m, 'core')})`;
	const up = r.patches.upstream.length
		? `, ${plural(r.patches.upstream.length, 'patch')} already upstream`
		: '';
	return `${r.target.ref}: ${r.merges.map(part).join(', ')}${up}; ${num(r.drift.files)} files drift`;
}

export function nextSteps(r: Pick<Report, 'work' | 'target' | 'patched' | 'merges' | 'patches'>) {
	const w = `${r.work}/w-${r.target.ref}`;
	const merged = r.merges.find((m) => m.name === 'patched')!;
	const steps = [
		`git -C ${r.work} worktree add --detach ${w} ${r.patched.commit}`,
		`git -C ${w} read-tree --reset -u ${merged.tree}`
	];
	if (r.patches.upstream.length)
		steps.unshift(
			`# already upstream: rerun with ${r.patches.upstream.map((p) => `--exclude-patch ${patchNumber(p)}`).join(' ')}`
		);
	steps.push(
		`# resolve the conflict markers, fix compile errors, then:`,
		`git -C ${w} add -A`,
		`c=$(git -C ${w} commit-tree -m "bump to ${r.target.ref}" -p ${r.patched.commit} ` +
			`-p ${r.target.commit} $(git -C ${w} write-tree))`,
		`scripts/kernel-bump-stage.sh ${r.work} $c <out dir>`
	);
	return steps;
}

export function formatReport(r: Report): string {
	const out = [
		`kernel bump check: ${r.base.ref} to ${r.target.ref}`,
		`base     ${r.base.ref} ${r.base.commit}`,
		`target   ${r.target.ref} ${r.target.commit} (from ${r.target.remote})`,
		`fork     ${r.fork.commit} (from ${r.fork.remote})`,
		`patches  ${r.patches.applied.length} applied to the base as ${r.patched.commit} (tree ${r.patched.tree})` +
			(r.patches.excluded.length ? `, excluded ${r.patches.excluded.join(' ')}` : ''),
		`drift    ${plural(r.drift.files, 'file')} changed, +${num(r.drift.insertions)} -${num(r.drift.deletions)}`
	];
	if (r.patches.upstream.length)
		out.push(`already upstream at the target: ${r.patches.upstream.join(' ')}`);
	for (const m of r.merges) {
		const label = m.name === 'fork' ? 'fork' : `fork + ${r.patches.applied.length} patches`;
		out.push(
			'',
			`${label} against ${r.target.ref}: exit ${m.exit}, tree ${m.tree}`,
			`  ${plural(m.conflicts.length, 'conflicted path')} (port ${share(m, 'port')}, core ${share(m, 'core')})`
		);
		for (const c of m.conflicts)
			out.push(
				`  ${c.path}  ${plural(c.hunks, 'hunk')}  ${c.side}  patches: ${c.patches.join(' ') || 'none'}`
			);
		for (const line of m.other) out.push(`  ${line}`);
	}
	out.push(
		'',
		`patch-touched paths changed upstream that merged clean (${r.changedClean.length}):`,
		...r.changedClean.map((p) => `  ${p}`),
		'',
		'next:',
		...r.next.map((s) => `  ${s}`)
	);
	return out.join('\n');
}

export const exitCode = (r: Report) =>
	r.merges.every((m) => m.exit === 0 && m.other.length === 0) ? 0 : 1;

// #endregion

// #region git

const IDENT = {
	GIT_AUTHOR_NAME: 'kernel-bump',
	GIT_AUTHOR_EMAIL: 'kernel-bump@localhost',
	GIT_AUTHOR_DATE: '1000000000 +0000',
	GIT_COMMITTER_NAME: 'kernel-bump',
	GIT_COMMITTER_EMAIL: 'kernel-bump@localhost',
	GIT_COMMITTER_DATE: '1000000000 +0000'
};

function gitIn(dir: string) {
	return (args: string[], env: Record<string, string> = {}, ok = [0]) => {
		const r = spawnSync('git', ['--literal-pathspecs', ...args], {
			cwd: dir,
			encoding: 'utf8',
			maxBuffer: 1 << 30,
			env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env }
		});
		if (r.error) throw new BumpError(`git: ${r.error.message}`);
		const status = r.status ?? -1;
		if (!ok.includes(status))
			throw new BumpError(
				`git ${args.slice(0, 3).join(' ')} exited ${status}: ${r.stderr.trim()}`
			);
		return { status, out: r.stdout };
	};
}

const lines = (text: string) => text.split('\n').filter(Boolean);

function fetchRef(g: ReturnType<typeof gitIn>, remotes: string[], spec: string, ref: string) {
	const failures: string[] = [];
	for (const remote of remotes) {
		try {
			g(['fetch', '--depth', '1', '--no-tags', '-q', remote, `+${spec}:${ref}`]);
			return remote;
		} catch (e) {
			failures.push(`${remote}: ${(e as Error).message}`);
		}
	}
	throw new BumpError(`could not fetch ${spec}\n${failures.join('\n')}`);
}

export interface Options {
	target: string;
	work?: string;
	excludePatches?: string[];
	forkRemote?: string;
	tagRemotes?: string[];
	sources?: string;
	patches?: string;
	releases?: string;
	log?: (text: string) => void;
}

const root = new URL('..', import.meta.url).pathname;

async function resolveTarget(target: string, releases: string) {
	if (target !== 'latest-stable' && target !== 'latest-mainline')
		return /^\d/.test(target) ? `v${target}` : target;
	const text = existsSync(releases)
		? readFileSync(releases, 'utf8')
		: await fetch(releases).then((res) => {
				if (!res.ok) throw new BumpError(`${releases}: HTTP ${res.status}`);
				return res.text();
			});
	return pickRelease(JSON.parse(text), target);
}

export async function check(opts: Options): Promise<Report> {
	const sources = JSON.parse(
		readFileSync(opts.sources ?? join(root, 'src/sources.json'), 'utf8')
	);
	const { commit: forkCommit, base } = sources.linux ?? {};
	if (!forkCommit || !base?.ref || !base?.commit)
		throw new BumpError('sources.json has no linux pin');
	const patchDir = resolve(opts.patches ?? join(root, 'src/kernel/patches'));
	const files = readdirSync(patchDir)
		.filter((f) => f.endsWith('.patch'))
		.sort();
	const { applied, excluded } = selectPatches(files, opts.excludePatches ?? []);

	const work = resolve(
		opts.work ?? process.env.KERNEL_BUMP_DIR ?? mkdtempSync(join(tmpdir(), 'kernel-bump-'))
	);
	mkdirSync(work, { recursive: true });
	const g = gitIn(work);
	if (!existsSync(join(work, '.git'))) g(['init', '-q', '.']);
	const forkRemote =
		opts.forkRemote ??
		execFileSync(join(root, 'scripts/ts'), [join(root, 'scripts/pin.ts'), 'linux', 'repo'], {
			encoding: 'utf8'
		}).trim();
	const tagRemotes = opts.tagRemotes?.length ? opts.tagRemotes : [STABLE, MAINLINE];
	const targetRef = await resolveTarget(opts.target, opts.releases ?? RELEASES);
	const log = opts.log ?? ((text: string) => console.error(`kernel-bump: ${text}`));
	const peel = (ref: string) => g(['rev-parse', '--verify', `${ref}^{commit}`]).out.trim();

	log(`fetching the fork ${forkCommit} from ${forkRemote}`);
	fetchRef(g, [forkRemote], forkCommit, 'refs/heads/fork');
	log(`fetching ${base.ref}`);
	fetchRef(g, tagRemotes, `refs/tags/${base.ref}`, `refs/tags/${base.ref}`);
	log(`fetching ${targetRef}`);
	const targetRemote = fetchRef(
		g,
		tagRemotes,
		`refs/tags/${targetRef}`,
		`refs/tags/${targetRef}`
	);
	const baseCommit = peel(`refs/tags/${base.ref}`);
	if (baseCommit !== base.commit)
		throw new BumpError(`${base.ref} is ${baseCommit}, sources.json pins ${base.commit}`);
	const forkSha = peel('refs/heads/fork');
	if (forkSha !== forkCommit)
		throw new BumpError(`fetched ${forkSha}, not the pinned ${forkCommit}`);
	const targetCommit = peel(`refs/tags/${targetRef}`);

	const gitDir = join(work, '.git');
	const patchedIndex = { GIT_INDEX_FILE: join(gitDir, 'bump-patched-index') };
	const targetIndex = { GIT_INDEX_FILE: join(gitDir, 'bump-target-index') };
	g(['read-tree', forkSha], patchedIndex);
	const abs = (f: string) => join(patchDir, f);
	if (applied.length) g(['apply', '--cached', ...applied.map(abs)], patchedIndex);
	const patchedTree = g(['write-tree'], patchedIndex).out.trim();
	const patchedCommit = g(
		[
			'commit-tree',
			patchedTree,
			'-p',
			forkSha,
			'-m',
			`${forkSha} with ${applied.length} patches`
		],
		IDENT
	).out.trim();
	g(['update-ref', 'refs/heads/fork-patched', patchedCommit]);

	const byPatch: Record<string, string[]> = {};
	for (const f of applied)
		byPatch[patchNumber(f)] = parseNumstat(g(['apply', '--numstat', abs(f)]).out);
	const touchedBy = pathPatches(byPatch);

	g(['read-tree', targetCommit], targetIndex);
	const upstream = applied.filter(
		(f) =>
			g(['apply', '--reverse', '--check', '--cached', abs(f)], targetIndex, [0, 1]).status ===
			0
	);

	// merge-tree labels the conflict markers with its arguments, and the tree id depends on the labels
	const merge = (name: 'fork' | 'patched', ours: string) => {
		const r = g(
			[
				'merge-tree',
				'--write-tree',
				'--name-only',
				`--merge-base=${baseCommit}`,
				ours,
				targetRef
			],
			{},
			[0, 1]
		);
		const parsed = parseMergeTree(r.out);
		return { name, exit: r.status, ...parsed };
	};
	const raw = [merge('fork', 'fork'), merge('patched', 'fork-patched')];

	const wanted = [...new Set([...raw.flatMap((m) => m.paths), ...Object.keys(touchedBy)])];
	const present = new Set(
		wanted.length ? lines(g(['ls-tree', '--name-only', baseCommit, '--', ...wanted]).out) : []
	);
	const merges: MergeResult[] = raw.map((m) => ({
		name: m.name,
		exit: m.exit,
		tree: m.tree,
		other: m.other,
		conflicts: m.paths.map((path) => {
			const blob = g(['cat-file', 'blob', `${m.tree}:${path}`], {}, [0, 128]);
			return {
				path,
				hunks: blob.status === 0 ? countHunks(blob.out) : 0,
				side: classify(path, !present.has(path)),
				patches: touchedBy[path] ?? []
			};
		})
	}));

	const touched = Object.keys(touchedBy);
	const changed = new Set(
		touched.length
			? lines(
					g([
						'diff',
						'--name-only',
						'--no-renames',
						baseCommit,
						targetCommit,
						'--',
						...touched
					]).out
				)
			: []
	);
	const conflicted = new Set(
		merges.find((m) => m.name === 'patched')!.conflicts.map((c) => c.path)
	);
	const changedClean = touched.filter((p) => changed.has(p) && !conflicted.has(p)).sort();
	const drift = parseShortstat(
		g(['diff', '--shortstat', '--no-renames', baseCommit, targetCommit]).out
	);

	const report: Report = {
		base: { ref: base.ref, commit: baseCommit },
		target: { ref: targetRef, commit: targetCommit, remote: targetRemote },
		fork: { commit: forkSha, remote: forkRemote },
		patched: { commit: patchedCommit, tree: patchedTree },
		patches: { applied, excluded, upstream },
		merges,
		drift,
		changedClean,
		work,
		summary: '',
		next: []
	};
	report.summary = summarize(report);
	report.next = nextSteps(report);
	return report;
}

// #endregion

async function main() {
	const args = process.argv.slice(2);
	const json = args.includes('--json');
	const all = (name: string) =>
		args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? args[i + 1]!.split(',') : []));
	const one = (name: string) => all(name)[0];
	try {
		if (args[0] !== 'check' || !one('target'))
			throw new BumpError(
				'usage: kernel-bump.ts check --target <tag|latest-stable|latest-mainline>'
			);
		const report = await check({
			target: one('target')!,
			work: one('work'),
			excludePatches: all('exclude-patch'),
			forkRemote: one('fork-remote'),
			tagRemotes: all('tag-remote'),
			sources: one('sources'),
			patches: one('patches'),
			releases: one('releases')
		});
		console.log(json ? JSON.stringify(report, null, '\t') : formatReport(report));
		process.exit(exitCode(report));
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		console.error(`kernel-bump: ${message}`);
		if (json) console.log(JSON.stringify({ error: message }));
		process.exit(2);
	}
}

if (import.meta.main ?? process.argv[1]?.endsWith('kernel-bump.ts')) main();
