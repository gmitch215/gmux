import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { sha256, verify, type PayloadLock, type PayloadManifest } from './payload.ts';

/**
 * fills build/ from the payload build.lock.json pins (or `--tag=<release>`, or `--from=<file>`),
 * after checking the tarball against the pinned SHA-256 and every file against its manifest.
 * `bun scripts/hydrate.ts [--tag=build-...] [--from=gmux-build.tar.gz] [--force]`
 */
const root = new URL('..', import.meta.url).pathname;
const build = join(root, 'build');
const REPO = process.env.GITHUB_REPOSITORY ?? 'gmitch215/gmux';
const arg = (name: string) =>
	process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

const lockPath = join(root, 'build.lock.json');
const pinned: PayloadLock | null = existsSync(lockPath)
	? JSON.parse(readFileSync(lockPath, 'utf8'))
	: null;

function download(tag: string, asset: string, dir: string): string {
	// gh reaches private repositories and drafts; the public URL needs nothing installed
	try {
		execFileSync(
			'gh',
			['release', 'download', tag, '--repo', REPO, '--dir', dir, '--pattern', asset],
			{
				stdio: ['ignore', 'ignore', 'inherit']
			}
		);
		return join(dir, asset);
	} catch {
		const url = `https://github.com/${REPO}/releases/download/${tag}/${asset}`;
		const response = execFileSync('curl', ['-fsSL', url]);
		writeFileSync(join(dir, asset), response);
		return join(dir, asset);
	}
}

const from = arg('from');
const tag = arg('tag') ?? pinned?.tag;
if (!from && !tag) {
	console.error('nothing to hydrate: no build.lock.json, and no --tag or --from given');
	process.exit(1);
}
const dir = mkdtempSync(join(tmpdir(), 'gmux-hydrate-'));
const asset = pinned?.asset ?? 'gmux-build.tar.gz';
const path = from ?? download(tag!, asset, dir);
const archive = new Uint8Array(readFileSync(path));
// a lock pins its own payload; an explicit --tag or --from is trusted by its own SHA256SUMS
const lock: PayloadLock =
	pinned && !arg('tag') && !from
		? pinned
		: {
				tag: tag ?? 'local',
				asset,
				sha256: expected(tag, from, asset, dir) ?? sha256(archive)
			};
const marker = join(build, '.payload');
if (
	!process.argv.includes('--force') &&
	existsSync(marker) &&
	readFileSync(marker, 'utf8') === lock.sha256
) {
	console.log(`build/ already holds ${lock.tag} (${lock.sha256.slice(0, 12)}); nothing to do`);
	process.exit(0);
}
const manifest = manifestFor(tag, from, dir);
const files = verify(archive, lock, manifest ?? undefined);
for (const file of files) {
	const target = join(build, file.path);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, file.data, { mode: file.executable ? 0o755 : 0o644 });
}
writeFileSync(marker, lock.sha256);
console.log(
	`build/: ${files.length} files from ${lock.tag}${manifest ? ', each checked against its manifest' : ''}`
);

function expected(tag: string | undefined, from: string | undefined, asset: string, dir: string) {
	const sums = from
		? join(dirname(from), 'SHA256SUMS')
		: tag
			? fetchBeside(tag, 'SHA256SUMS', dir)
			: null;
	if (!sums || !existsSync(sums)) return null;
	const line = readFileSync(sums, 'utf8')
		.split('\n')
		.find((l) => l.endsWith(`  ${asset}`));
	return line?.split(' ')[0] ?? null;
}

function manifestFor(
	tag: string | undefined,
	from: string | undefined,
	dir: string
): PayloadManifest | null {
	const path = from
		? join(dirname(from), 'manifest.json')
		: tag
			? fetchBeside(tag, 'manifest.json', dir)
			: null;
	return path && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

function fetchBeside(tag: string, name: string, dir: string): string | null {
	try {
		return download(tag, name, dir);
	} catch {
		return null;
	}
}
