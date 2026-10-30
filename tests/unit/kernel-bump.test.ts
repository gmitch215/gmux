import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	BumpError,
	check,
	classify,
	countHunks,
	exitCode,
	formatReport,
	parseMergeTree,
	parseNumstat,
	parseShortstat,
	patchNumber,
	pathPatches,
	pickRelease,
	selectPatches,
	summarize
} from '../../scripts/kernel-bump.ts';

describe('parseMergeTree', () => {
	it('reads the tree and nothing else from a clean merge', () => {
		expect(parseMergeTree('abc123\n')).toEqual({ tree: 'abc123', paths: [], other: [] });
	});

	it('reads the conflicted paths and keeps the conflicts that are not content', () => {
		const text = [
			'abc123',
			'fs/inode.c',
			'fs/gone.c',
			'',
			'Auto-merging fs/inode.c',
			'CONFLICT (content): Merge conflict in fs/inode.c',
			'CONFLICT (modify/delete): fs/gone.c deleted in HEAD and modified in theirs.',
			''
		].join('\n');
		expect(parseMergeTree(text)).toEqual({
			tree: 'abc123',
			paths: ['fs/inode.c', 'fs/gone.c'],
			other: ['CONFLICT (modify/delete): fs/gone.c deleted in HEAD and modified in theirs.']
		});
	});
});

describe('countHunks', () => {
	it('counts conflict openers only', () => {
		const blob = 'a\n<<<<<<< ours\nb\n=======\nc\n>>>>>>> theirs\n<<<<<<< ours\n<<<<<<<\n';
		expect(countHunks(blob)).toBe(2);
		expect(countHunks('plain\n')).toBe(0);
	});
});

describe('classify', () => {
	it('calls arch/wasm and paths absent at the base tag the port, the rest core', () => {
		expect(classify('arch/wasm/mm/owner.c', false)).toBe('port');
		expect(classify('include/linux/hostnet.h', true)).toBe('port');
		expect(classify('fs/inode.c', false)).toBe('core');
	});
});

describe('patch paths', () => {
	it('numbers a patch by its file name prefix', () => {
		expect(patchNumber('0042-wasm-run-every-exec.patch')).toBe('0042');
	});

	it('reads paths from numstat output, plain or git-style, once each', () => {
		const text = '3\t1\tfs/inode.c\n-\t-\tlogo.png\n2\t0\tfs/inode.c\n\n';
		expect(parseNumstat(text)).toEqual(['fs/inode.c', 'logo.png']);
	});

	it('maps each path to the patches that touch it', () => {
		const byPatch = {
			'0022': ['fs/inode.c', 'include/linux/fs.h'],
			'0029': ['include/linux/fs.h']
		};
		expect(pathPatches(byPatch)).toEqual({
			'fs/inode.c': ['0022'],
			'include/linux/fs.h': ['0022', '0029']
		});
	});
});

describe('parseShortstat', () => {
	it('reads the three counts, and zeros from nothing', () => {
		const text = ' 24325 files changed, 1600970 insertions(+), 660173 deletions(-)\n';
		expect(parseShortstat(text)).toEqual({
			files: 24325,
			insertions: 1600970,
			deletions: 660173
		});
		expect(parseShortstat(' 1 file changed, 1 insertion(+)\n')).toEqual({
			files: 1,
			insertions: 1,
			deletions: 0
		});
		expect(parseShortstat('')).toEqual({ files: 0, insertions: 0, deletions: 0 });
	});
});

describe('pickRelease', () => {
	const json = {
		latest_stable: { version: '7.3.1' },
		releases: [
			{ moniker: 'mainline', version: '7.4-rc2' },
			{ moniker: 'stable', version: '7.3.1' }
		]
	};

	it('turns latest-stable and latest-mainline into tags', () => {
		expect(pickRelease(json, 'latest-stable')).toBe('v7.3.1');
		expect(pickRelease(json, 'latest-mainline')).toBe('v7.4-rc2');
	});

	it('refuses a listing without the release', () => {
		expect(() => pickRelease({}, 'latest-stable')).toThrow(BumpError);
	});
});

describe('selectPatches', () => {
	const files = ['0001-a.patch', '0002-b.patch', '0043-c.patch'];

	it('splits the excluded patches out, by number with or without padding', () => {
		expect(selectPatches(files, ['43'])).toEqual({
			applied: ['0001-a.patch', '0002-b.patch'],
			excluded: ['0043-c.patch']
		});
	});

	it('refuses a number that names no patch', () => {
		expect(() => selectPatches(files, ['0099'])).toThrow('no patch 0099');
	});
});

describe('summarize', () => {
	const merge = (name: 'fork' | 'patched', paths: [string, 'port' | 'core'][]) => ({
		name,
		exit: paths.length ? 1 : 0,
		tree: 't',
		other: [],
		conflicts: paths.map(([path, side]) => ({ path, hunks: 1, side, patches: [] }))
	});

	it('says what conflicted, by side, and what is already upstream', () => {
		const text = summarize({
			target: { ref: 'v7.3', commit: 'c', remote: 'r' },
			merges: [merge('fork', []), merge('patched', [['fs/inode.c', 'core']])],
			patches: { applied: [], excluded: [], upstream: ['0043-x.patch'] },
			drift: { files: 24325, insertions: 1, deletions: 1 }
		});
		expect(text).toBe(
			'v7.3: fork clean, patched 1 conflicted path (port 0, core 1), 1 patch already upstream; 24,325 files drift'
		);
	});
});

describe('check on synthetic repositories', () => {
	const env = {
		...process.env,
		GIT_AUTHOR_NAME: 't',
		GIT_AUTHOR_EMAIL: 't@localhost',
		GIT_COMMITTER_NAME: 't',
		GIT_COMMITTER_EMAIL: 't@localhost',
		GIT_CONFIG_COUNT: '2',
		GIT_CONFIG_KEY_0: 'commit.gpgsign',
		GIT_CONFIG_VALUE_0: 'false',
		GIT_CONFIG_KEY_1: 'tag.gpgsign',
		GIT_CONFIG_VALUE_1: 'false'
	};
	const git = (dir: string, ...args: string[]) =>
		execFileSync('git', args, { cwd: dir, encoding: 'utf8', env }).trim();
	const pad = (n: number) => String(n).padStart(2, '0');
	const body = (name: string, edits: Record<number, string> = {}) =>
		Array.from({ length: 20 }, (_, i) => edits[i + 1] ?? `${name}${pad(i + 1)}`).join('\n') +
		'\n';
	const plain = (path: string, n: number, to: string) => {
		const name = path[0]!;
		const start = Math.max(1, n - 3);
		const end = Math.min(20, n + 3);
		const rows: string[] = [];
		for (let i = start; i <= end; i++)
			rows.push(i === n ? `-${name}${pad(i)}\n+${to}` : ` ${name}${pad(i)}`);
		return `--- a/${path}\n+++ b/${path}\n@@ -${start},${end - start + 1} +${start},${end - start + 1} @@\n${rows.join('\n')}\n`;
	};

	function setup() {
		const dir = mkdtempSync(join(tmpdir(), 'kernel-bump-test-'));
		const up = join(dir, 'up');
		const patches = join(dir, 'patches');
		mkdirSync(up);
		mkdirSync(patches);
		git(up, 'init', '-q', '-b', 'main');
		const write = (path: string, text: string) => {
			mkdirSync(join(up, path, '..'), { recursive: true });
			writeFileSync(join(up, path), text);
		};
		for (const f of 'abcdez') write(`${f}.c`, body(f));
		git(up, 'add', '-A');
		git(up, 'commit', '-q', '-m', 'base');
		git(up, 'tag', '-a', 'v1.0', '-m', 'v1.0');
		const baseCommit = git(up, 'rev-parse', 'v1.0^{commit}');

		git(up, 'checkout', '-q', '-b', 'fork');
		write('a.c', body('a', { 5: 'a05 fork' }));
		write('b.c', body('b', { 10: 'b10 fork' }));
		write('arch/wasm/x.c', 'int x;\n');
		git(up, 'add', '-A');
		git(up, 'commit', '-q', '-m', 'fork');
		const fork = git(up, 'rev-parse', 'HEAD');

		git(up, 'checkout', '-q', '-b', 'up1', 'main');
		write('a.c', body('a', { 5: 'a05 up' }));
		write('b.c', body('b', { 18: 'b18 up' }));
		write('c.c', body('c', { 3: 'c03 up' }));
		write('d.c', body('d', { 18: 'd18 up' }));
		write('e.c', body('e', { 2: 'e02 patched' }));
		git(up, 'add', '-A');
		git(up, 'commit', '-q', '-m', 'one');
		git(up, 'tag', '-a', 'v1.1', '-m', 'v1.1');

		git(up, 'checkout', '-q', '-b', 'up2', 'main');
		write('z.c', body('z', { 1: 'z01 up' }));
		git(up, 'add', '-A');
		git(up, 'commit', '-q', '-m', 'two');
		git(up, 'tag', '-a', 'v1.2', '-m', 'v1.2');

		writeFileSync(join(patches, '0001-c.patch'), plain('c.c', 3, 'c03 patched'));
		writeFileSync(join(patches, '0002-d.patch'), plain('d.c', 10, 'd10 patched'));
		writeFileSync(join(patches, '0003-e.patch'), plain('e.c', 2, 'e02 patched'));
		writeFileSync(
			join(patches, '0004-new.patch'),
			'--- /dev/null\n+++ b/arch/wasm/new.c\n@@ -0,0 +1 @@\n+int y;\n'
		);
		const sources = join(dir, 'sources.json');
		writeFileSync(
			sources,
			JSON.stringify({ linux: { commit: fork, base: { ref: 'v1.0', commit: baseCommit } } })
		);
		return { dir, up, patches, sources, fork };
	}

	let shared: ReturnType<typeof setup> | undefined;
	const fixture = () => (shared ??= setup());

	const run = (s: ReturnType<typeof setup>, target: string, extra: object = {}) =>
		check({
			target,
			work: join(s.dir, 'work'),
			forkRemote: s.up,
			tagRemotes: [s.up],
			sources: s.sources,
			patches: s.patches,
			log: () => {},
			...extra
		});

	it('merges the fork and the patched fork into the target and reports each conflict', async () => {
		const s = fixture();
		const report = await run(s, 'v1.1');
		expect(exitCode(report)).toBe(1);
		expect(report.patches.applied).toHaveLength(4);
		expect(report.patches.upstream).toEqual(['0003-e.patch']);
		expect(report.drift).toEqual({ files: 5, insertions: 5, deletions: 5 });

		const [fork, patched] = report.merges;
		expect(fork!.exit).toBe(1);
		expect(fork!.conflicts).toEqual([{ path: 'a.c', hunks: 1, side: 'core', patches: [] }]);
		expect(patched!.conflicts).toEqual([
			{ path: 'a.c', hunks: 1, side: 'core', patches: [] },
			{ path: 'c.c', hunks: 1, side: 'core', patches: ['0001'] }
		]);
		expect(report.changedClean).toEqual(['d.c', 'e.c']);
		expect(report.summary).toBe(
			'v1.1: fork 1 conflicted path (port 0, core 1), patched 2 conflicted paths (port 0, core 2), ' +
				'1 patch already upstream; 5 files drift'
		);
		const text = formatReport(report);
		expect(text).toContain('c.c  1 hunk  core  patches: 0001');
		expect(text).toContain('already upstream at the target: 0003-e.patch');
		expect(text).toContain('scripts/kernel-bump-stage.sh');
		const marked = git(report.work, 'cat-file', 'blob', `${patched!.tree}:c.c`);
		expect(marked).toContain('<<<<<<< fork-patched');
		expect(marked).toContain('>>>>>>> v1.1');
	});

	it('leaves an excluded patch out of the patched fork', async () => {
		const s = fixture();
		const report = await run(s, 'v1.1', { excludePatches: ['0001'] });
		expect(report.patches.excluded).toEqual(['0001-c.patch']);
		expect(report.merges[1]!.conflicts.map((c) => c.path)).toEqual(['a.c']);
	});

	it('exits 0 when the target touches nothing the fork or the patches touch', async () => {
		const s = fixture();
		const report = await run(s, 'v1.2');
		expect(exitCode(report)).toBe(0);
		expect(report.patches.upstream).toEqual([]);
		expect(report.merges.map((m) => m.conflicts)).toEqual([[], []]);
		expect(report.changedClean).toEqual([]);
	});

	it('stops when the base tag is not the pinned commit', async () => {
		const s = fixture();
		const wrong = join(s.dir, 'wrong-base.json');
		writeFileSync(
			wrong,
			JSON.stringify({
				linux: { commit: s.fork, base: { ref: 'v1.0', commit: 'b'.repeat(40) } }
			})
		);
		await expect(run(s, 'v1.1', { sources: wrong })).rejects.toThrow('sources.json pins');
	});
});
