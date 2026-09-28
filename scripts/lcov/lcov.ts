import { isAbsolute, relative, sep } from 'node:path';

/**
 * lcov records as the coverage scripts write them: line counts per repo-relative file, and functions
 * when there are any. Codecov maps a report onto the tree by path, so an absolute or escaping path
 * matches nothing and the whole upload is dropped without an error; `checkLcov` refuses those.
 */
export interface FileCoverage {
	/** repo-relative, forward slashes */
	file: string;
	lines: Map<number, number>;
	/** name -> [first line, entry count] */
	functions?: Map<string, [number, number]>;
}

export function formatLcov(files: Iterable<FileCoverage>): string {
	const out: string[] = [];
	for (const f of [...files].sort((a, b) => a.file.localeCompare(b.file))) {
		out.push('TN:', `SF:${f.file}`);
		const fns = [...(f.functions ?? [])].sort((a, b) => a[1][0] - b[1][0]);
		for (const [name, [line]] of fns) out.push(`FN:${line},${name}`);
		for (const [name, [, n]] of fns) out.push(`FNDA:${n},${name}`);
		if (fns.length)
			out.push(`FNF:${fns.length}`, `FNH:${fns.filter(([, [, n]]) => n > 0).length}`);
		const lines = [...f.lines].sort((a, b) => a[0] - b[0]);
		for (const [line, n] of lines) out.push(`DA:${line},${n}`);
		out.push(
			`LF:${lines.length}`,
			`LH:${lines.filter(([, n]) => n > 0).length}`,
			'end_of_record'
		);
	}
	return out.join('\n') + '\n';
}

export function parseLcov(text: string): FileCoverage[] {
	const files: FileCoverage[] = [];
	let at: FileCoverage | null = null;
	for (const raw of text.split('\n')) {
		const line = raw.trim();
		const colon = line.indexOf(':');
		const key = colon < 0 ? line : line.slice(0, colon);
		const value = line.slice(colon + 1);
		if (key === 'SF') files.push((at = { file: value, lines: new Map() }));
		else if (key === 'end_of_record') at = null;
		else if (!at) continue;
		else if (key === 'DA') {
			const [n, count] = value.split(',');
			const line = Number(n);
			at.lines.set(line, (at.lines.get(line) ?? 0) + Number(count));
		} else if (key === 'FN') {
			const comma = value.indexOf(',');
			(at.functions ??= new Map()).set(value.slice(comma + 1), [
				Number(value.slice(0, comma)),
				0
			]);
		} else if (key === 'FNDA') {
			const comma = value.indexOf(',');
			const name = value.slice(comma + 1);
			const fn = at.functions?.get(name);
			if (fn) fn[1] += Number(value.slice(0, comma));
		}
	}
	return files;
}

/** a path as the report must name it: relative to the repo root, forward slashes; null outside it */
export function repoPath(root: string, path: string): string | null {
	const rel = isAbsolute(path) ? relative(root, path) : path;
	if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
	return rel.split(sep).join('/').replace(/^\.\//, '');
}

export interface LcovCheck {
	files: number;
	lines: number;
	hit: number;
	/** paths Codecov cannot place: absolute, escaping the repo, or with backslashes */
	bad: string[];
}

export function checkLcov(text: string): LcovCheck {
	const files = parseLcov(text);
	let lines = 0;
	let hit = 0;
	for (const f of files) {
		lines += f.lines.size;
		for (const n of f.lines.values()) if (n > 0) hit++;
	}
	const bad = files
		.map((f) => f.file)
		.filter(
			(p) =>
				p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.startsWith('..') || p.includes('\\')
		);
	return { files: files.length, lines, hit, bad };
}

/** the summary line a script prints, and a nonzero exit for a report Codecov would drop */
export function report(name: string, text: string): number {
	const c = checkLcov(text);
	if (!c.files || !c.lines) {
		console.error(`${name}: the report names no lines`);
		return 1;
	}
	if (c.bad.length) {
		console.error(
			`${name}: ${c.bad.length} paths Codecov cannot place: ${c.bad.slice(0, 5).join(' ')}`
		);
		return 1;
	}
	const pct = ((100 * c.hit) / c.lines).toFixed(2);
	console.log(
		`${name}: ${c.files} files, ${c.hit}/${c.lines} lines (${pct}%), all paths repo-relative`
	);
	return 0;
}
