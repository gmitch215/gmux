import { createReadStream, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

/**
 * Tabulates the strace -f traces share.sh writes: syscalls by number, open-to-close transactions by
 * signature and path class, listings, stat-family calls, and the top recurring per-process
 * sequences. Prints markdown.
 * `node --no-warnings --experimental-strip-types experiments/syscall-cost/scripts/share.ts <out dir>`
 */
const dir = process.argv[2];
if (!dir) throw new Error('usage: share.ts <share.sh out dir>');

const numbers = new Map<string, number>();
for (const line of readFileSync(join(dir, 'nr.txt'), 'utf8').split('\n')) {
	const m = /#define __NR(?:3264)?_(\w+)\s+(\d+)/.exec(line);
	if (m) numbers.set(m[1], Number(m[2]));
}
const nr = (name: string) => numbers.get(name) ?? numbers.get(name.replace(/^new/, '')) ?? -1;

const FD_CALLS = new Set([
	'read', 'write', 'pread64', 'pwrite64', 'readv', 'writev', 'lseek', 'fstat', 'fcntl', 'ioctl',
	'getdents64', 'fstatfs', 'flock', 'ftruncate', 'fsync', 'fdatasync', 'fadvise64', 'fchmod',
	'fchown', 'sendfile', 'readahead', 'close', 'fchdir'
]);
const STAT_CALLS = new Set(['newfstatat', 'fstat', 'statx', 'faccessat', 'faccessat2', 'statfs']);
const SYSTEM = ['/usr/', '/lib/', '/etc/', '/bin/', '/sbin/', '/opt/'];

function pathClass(path: string): string {
	if (SYSTEM.some((p) => path.startsWith(p))) return 'system';
	if (path.startsWith('/w/')) return 'build tree';
	if (/^\/(proc|dev|sys)\b/.test(path)) return 'proc/dev/sys';
	if (path.startsWith('/tmp/') || path.startsWith('/out/')) return 'tmp';
	return path.startsWith('/') ? 'other abs' : 'relative';
}

function signature(calls: string[]): string {
	const out: string[] = [];
	for (const c of calls) {
		const last = out[out.length - 1];
		if (last === c || last === `${c}*`) out[out.length - 1] = `${c}*`;
		else out.push(c);
	}
	return out.join(' ');
}

const bump = <K>(m: Map<K, number>, k: K, n = 1) => m.set(k, (m.get(k) ?? 0) + n);
const top = <K>(m: Map<K, number>, n: number) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n);
const pct = (a: number, b: number) => (b ? ((100 * a) / b).toFixed(1) : '0.0');

interface Open {
	path: string;
	flags: string;
	calls: string[];
}

async function tabulate(file: string) {
	const byName = new Map<string, number>();
	const failed = new Map<string, number>();
	const txns = new Map<string, number>();
	const txnByClass = new Map<string, number>();
	const sysPaths = new Map<string, number>();
	const grams = new Map<string, number>();
	const open = new Map<string, Open>();
	const window = new Map<number, string[]>();
	const pids = new Set<number>();
	let total = 0;
	let unclosed = 0;
	let roSystem = 0;
	let roSystemPlain = 0;
	let listings = 0;
	let dirCalls = 0;

	const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
	for await (const line of rl) {
		const m = /^(\d+)\s+(?:<\.\.\. (\w+) resumed>|(\w+)\()(.*)$/.exec(line);
		if (!m) continue;
		if (line.endsWith('<unfinished ...>')) continue;
		const pid = Number(m[1]);
		const name = m[2] ?? m[3];
		const rest = m[4];
		const ret = /\) += (-?\d+|\?)(?: (\w+))?/.exec(rest) ?? / = (-?\d+|\?)(?: (\w+))?/.exec(rest);
		const value = ret && ret[1] !== '?' ? Number(ret[1]) : NaN;
		total++;
		pids.add(pid);
		bump(byName, name);
		if (value < 0 && ret?.[2] && STAT_CALLS.has(name)) bump(failed, `${name} ${ret[2]}`);
		if (value < 0 && ret?.[2] && (name === 'openat' || name === 'open')) bump(failed, `${name} ${ret[2]}`);
		const w = window.get(pid) ?? [];
		w.push(name);
		if (w.length > 4) w.shift();
		window.set(pid, w);
		if (w.length === 4) bump(grams, w.join(' > '));
		if (name === 'openat' && !line.includes('resumed') && value >= 0) {
			const a = /^(?:AT_FDCWD|\d+), "((?:[^"\\]|\\.)*)"(?:\.\.\.)?, ([A-Z_|0-9]+)/.exec(rest);
			if (a) open.set(`${pid}:${value}`, { path: a[1], flags: a[2], calls: [] });
			continue;
		}
		if (!FD_CALLS.has(name)) continue;
		const fd = /^(\d+)[,)]/.exec(rest)?.[1];
		const o = fd ? open.get(`${pid}:${fd}`) : undefined;
		if (!o) continue;
		if (name === 'getdents64') dirCalls++;
		if (name !== 'close') {
			o.calls.push(name);
			continue;
		}
		open.delete(`${pid}:${fd}`);
		const kind = o.flags.includes('O_DIRECTORY')
			? 'dir'
			: /O_WRONLY|O_RDWR|O_CREAT|O_TRUNC/.test(o.flags)
				? 'write'
				: 'ro';
		const cls = pathClass(o.path);
		const sig = `openat[${kind}] > ${signature(o.calls)}${o.calls.length ? ' > ' : ''}close`;
		bump(txns, `${cls}: ${sig}`);
		bump(txnByClass, `${cls} ${kind}`);
		if (kind === 'dir') listings++;
		if (kind === 'ro' && cls === 'system') {
			roSystem++;
			bump(sysPaths, o.path);
			if (o.calls.every((c) => c === 'read' || c === 'fstat' || c === 'lseek' || c === 'fcntl')) roSystemPlain++;
		}
	}
	unclosed = open.size;
	return {
		total, pids: pids.size, byName, failed, txns, txnByClass, sysPaths, grams, unclosed,
		roSystem, roSystemPlain, listings, dirCalls
	};
}

for (const phase of ['configure', 'make']) {
	const r = await tabulate(join(dir, `${phase}.st`));
	const stat = [...r.byName].filter(([n]) => STAT_CALLS.has(n)).reduce((s, [, c]) => s + c, 0);
	const txnTotal = [...r.txns.values()].reduce((s, c) => s + c, 0);
	console.log(`\n## ${phase}: ${r.total} syscalls in ${r.pids} processes\n`);
	console.log('| syscall | nr | calls | share % |\n| --- | --- | --- | --- |');
	for (const [n, c] of top(r.byName, 25)) console.log(`| ${n} | ${nr(n)} | ${c} | ${pct(c, r.total)} |`);
	console.log(`\nstat family (newfstatat, fstat, statx, faccessat, faccessat2, statfs): ${stat} (${pct(stat, r.total)}%)`);
	console.log(`getdents64 calls: ${r.dirCalls}; directory listings (open O_DIRECTORY to close): ${r.listings}`);
	console.log(`open-to-close transactions: ${txnTotal}; opens never closed (execve or exit closed them): ${r.unclosed}`);
	console.log(`read-only opens of system files: ${r.roSystem} (${pct(r.roSystem, txnTotal)}% of transactions), ${r.roSystemPlain} of them only read/fstat/lseek/fcntl, distinct paths ${r.sysPaths.size}`);
	console.log('\n| open-to-close class | transactions |\n| --- | --- |');
	for (const [k, c] of top(r.txnByClass, 12)) console.log(`| ${k} | ${c} |`);
	console.log('\n| top transactions | count |\n| --- | --- |');
	for (const [k, c] of top(r.txns, 10)) console.log(`| ${k} | ${c} |`);
	console.log('\n| top four-call windows (per process, names only) | count |\n| --- | --- |');
	for (const [k, c] of top(r.grams, 10)) console.log(`| ${k} | ${c} |`);
	console.log('\n| most reopened system files | opens |\n| --- | --- |');
	for (const [k, c] of top(r.sysPaths, 10)) console.log(`| ${k} | ${c} |`);
	console.log('\n| failed stat-family and open calls | count |\n| --- | --- |');
	for (const [k, c] of top(r.failed, 8)) console.log(`| ${k} | ${c} |`);
}
