import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * compares each mirror in src/mirrors.json with the repository its pin came from, and checks the
 * pinned commit is on the mirror. `sync-mirrors.ts [--apply]`; --apply copies new and moved
 * branches and new tags to the mirror and needs a gh login with write access to it
 */
export type Refs = Record<string, string>;

export function parseRefs(lsRemote: string): Refs {
	const refs: Refs = {};
	for (const line of lsRemote.split('\n')) {
		const [sha, ref] = line.split('\t');
		if (sha && ref && !ref.endsWith('^{}')) refs[ref] = sha;
	}
	return refs;
}

export function drift(origin: Refs, mirror: Refs): { added: Refs; moved: Refs } {
	const added: Refs = {};
	const moved: Refs = {};
	for (const [ref, sha] of Object.entries(origin)) {
		if (!(ref in mirror)) added[ref] = sha;
		else if (mirror[ref] !== sha) moved[ref] = sha;
	}
	return { added, moved };
}

export const slug = (url: string) =>
	url.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');

const root = new URL('..', import.meta.url).pathname;
const read = (file: string) => JSON.parse(readFileSync(`${root}src/${file}`, 'utf8'));
const run = (cmd: string, args: string[]) =>
	execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
const refsOf = (url: string) => parseRefs(run('git', ['ls-remote', '--heads', '--tags', url]));
const notice = (text: string) =>
	console.log(process.env.GITHUB_ACTIONS ? `::notice::${text}` : text);

function main() {
	const apply = process.argv.includes('--apply');
	const sources = read('sources.json');
	let failed = false;
	for (const [name, mirror] of Object.entries<string>(read('mirrors.json'))) {
		const { repo: origin, commit } = sources[name];
		const { added, moved } = drift(refsOf(origin), refsOf(mirror));
		try {
			run('gh', ['api', `repos/${slug(mirror)}/commits/${commit}`, '--silent']);
		} catch {
			console.error(`${name}: the pinned commit ${commit} is not on ${mirror}`);
			failed = true;
		}
		for (const [ref, sha] of Object.entries(added)) notice(`${name}: ${ref} is new at ${sha}`);
		for (const [ref, sha] of Object.entries(moved)) notice(`${name}: ${ref} moved to ${sha}`);
		if (!apply) continue;
		const calls = [
			...Object.keys(moved)
				.filter((ref) => ref.startsWith('refs/heads/'))
				.map((ref) => ['merge-upstream', `branch=${ref.slice('refs/heads/'.length)}`]),
			...Object.entries(added).map(([ref, sha]) => ['git/refs', `ref=${ref}`, `sha=${sha}`])
		];
		for (const [path, ...fields] of calls) {
			try {
				run('gh', [
					'api',
					'-X',
					'POST',
					`repos/${slug(mirror)}/${path}`,
					...fields.flatMap((f) => ['-f', f])
				]);
			} catch {
				console.error(`${name}: ${path} ${fields.join(' ')} failed`);
				failed = true;
			}
		}
	}
	process.exit(failed ? 1 : 0);
}

if (import.meta.main ?? process.argv[1]?.endsWith('sync-mirrors.ts')) main();
