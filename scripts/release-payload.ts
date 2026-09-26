import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
	packTar,
	sha256,
	type PayloadFile,
	type PayloadLock,
	type PayloadManifest
} from './payload.ts';

/**
 * packs the staged build (the kernel, the probes and Katybug's test binaries under build/) into
 * payload/: gmux-build.tar.gz, its manifest.json and SHA256SUMS. `--publish` also creates the
 * prerelease `build-<commit>` on GitHub with them (gh CLI) and pins it in build.lock.json, which CI
 * and `bun run hydrate` read. `bun scripts/release-payload.ts [--publish]`
 */
const root = new URL('..', import.meta.url).pathname;
const build = join(root, 'build');
const out = join(root, 'payload');
const DIRS = ['kernel', 'probes', 'katybug'];
const ASSET = 'gmux-build.tar.gz';

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? walk(path) : [path];
	});
}

for (const dir of DIRS)
	if (!existsSync(join(build, dir))) {
		console.error(
			`build/${dir} is missing: stage a pipeline run with scripts/build-kernel.sh first`
		);
		process.exit(1);
	}
const files: PayloadFile[] = DIRS.flatMap((dir) => walk(join(build, dir))).map((path) => ({
	path: relative(build, path),
	data: new Uint8Array(readFileSync(path)),
	executable: (statSync(path).mode & 0o111) !== 0
}));
const archive = packTar(files);
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version as string;
const manifest: PayloadManifest = {
	version,
	commit,
	files: Object.fromEntries(files.map((f) => [f.path, sha256(f.data)]).sort())
};
mkdirSync(out, { recursive: true });
writeFileSync(join(out, ASSET), archive);
writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, '\t')}\n`);
writeFileSync(
	join(out, 'SHA256SUMS'),
	`${sha256(archive)}  ${ASSET}\n${sha256(readFileSync(join(out, 'manifest.json')))}  manifest.json\n`
);
console.log(
	`payload/${ASSET}: ${files.length} files, ${archive.length} bytes, sha256 ${sha256(archive)}`
);

if (process.argv.includes('--publish')) {
	const tag = `build-${commit.slice(0, 12)}`;
	execFileSync(
		'gh',
		[
			'release',
			'create',
			tag,
			'--prerelease',
			'--title',
			`gmux build ${commit.slice(0, 12)}`,
			'--notes',
			`Pipeline output for ${commit}, staged by scripts/build-kernel.sh. Hydrate with \`bun run hydrate --tag=${tag}\`.`,
			join(out, ASSET),
			join(out, 'manifest.json'),
			join(out, 'SHA256SUMS')
		],
		{ cwd: root, stdio: 'inherit' }
	);
	const lock: PayloadLock = { tag, asset: ASSET, sha256: sha256(archive) };
	writeFileSync(join(root, 'build.lock.json'), `${JSON.stringify(lock, null, '\t')}\n`);
	console.log(`published ${tag}; build.lock.json now pins it`);
}
