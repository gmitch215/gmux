import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostRuntime } from '../../../scripts/wasm/router-modules.ts';
import { Machine } from '../../../src/worker/machine/machine.ts';

/**
 * Checks the kernel's one-call path walk (patch 0036's wasm_fs_chain, through Machine.statxChain)
 * against the kernel's own statx answers: a guest runs stat over paths that cross directories,
 * symlinks, mount points, missing names and a file used as a directory, and for every walk the
 * host kept, the inode number of each prefix must be the one the kernel's statx answered for that
 * prefix (low 32 bits), and a walk the host gave up on must be one that crosses a symlink, a mount
 * or a missing name. GMUX_BUILD names the build. Exits 1 on a difference or when nothing was compared.
 * `node --experimental-strip-types experiments/syscall-cost/scripts/chain.ts`
 */
const root = new URL('../../../', import.meta.url).pathname;
const kernel = join(process.env.GMUX_BUILD ?? join(root, 'build'), 'kernel');
const read = (path: string) => new Uint8Array(readFileSync(path));
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(readFileSync(join(kernel, 'manifest.json'), 'utf8'));

let output = '';
const machine = new Machine({
	vmlinux: new WebAssembly.Module(read(join(kernel, 'vmlinux.wasm'))),
	initrd: read(join(kernel, 'initramfs.bin')),
	cmdline: 'maxcpus=3 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0',
	registry: new Map([[manifest.busybox, new WebAssembly.Module(read(join(kernel, 'busybox.wasm')))]]),
	maximumPages: 1024,
	sha256,
	sharedKernel: true,
	syscallCache: 'verify',
	runtime: hostRuntime(),
	write: (text) => (output += text)
});

const m = machine as any;
const text = (bytes: Uint8Array) => String.fromCharCode(...bytes);
// what the kernel answered about each path, and what the walk of it returned
const answers = new Map<string, { ino: number; mode: number; flags: number }>();
const walks = new Map<
	string,
	{ name: string; inos: number[] | null; result: number; flags: number }
>();
const chainOriginal = m.statxChain.bind(machine);
let lastChain: number[] | null = null;
m.statxChain = (...args: unknown[]) => (lastChain = chainOriginal(...args));
const fillOriginal = m.statxFill.bind(machine);
m.statxFill = (me: unknown, q: { path: Uint8Array; flags: number }, result: number, buf: number) => {
	lastChain = null;
	const name = text(q.path);
	// only a statx that does not follow a final symlink answers about the path's own inode
	if (result === 0 && q.flags & 0x100) {
		const view = new DataView(m.userMemory(me).buffer);
		answers.set(name, { ino: view.getUint32(buf + 32, true), mode: view.getUint16(buf + 28, true), flags: q.flags });
	}
	const out = fillOriginal(me, q, result, buf);
	walks.set(`${q.flags & 0x100}:${name}`, { name, inos: lastChain, result, flags: q.flags });
	return out;
};

const run = async (until: () => boolean) => {
	const t = Date.now();
	await machine.run(
		() => until() || Date.now() - t > Number(process.env.TIMEOUT_MS ?? 300_000),
		(ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5)))
	);
	if (!until()) throw new Error(`stuck: ${output.slice(-300)}`);
};
await run(() => output.includes('# '));
const command = async (cmd: string) => {
	const marker = `@@${Math.random().toString(36).slice(2, 8)}`;
	const at = output.length;
	machine.type(`${cmd}; echo ${marker}$((1+1))\n`);
	await run(() => output.slice(at).includes(`${marker}2\r\n`));
};

await command('mkdir -p /w/a/b/c; echo x > /w/a/f; echo y > /w/a/b/c/g; ln -s /w/a/b /w/l; ln -s f /w/a/rel; ln -s /w/a/nope /w/dangling');
await command('mount -t tmpfs none /w/a/b/c');
await command('echo z > /w/a/b/c/h');
const PATHS = [
	'/', '/bin', '/bin/busybox', '/bin/ls', '/etc', '/etc/passwd', '/etc/none', '/none', '/none/deeper',
	'/bin/busybox/x', '/bin/', '//bin//busybox', '/usr', '/usr/bin', '/usr/bin/env', '/sbin/init',
	'/w', '/w/a', '/w/a/f', '/w/a/f/x', '/w/a/none', '/w/a/b', '/w/a/b/c', '/w/a/b/c/g', '/w/a/b/c/h',
	'/w/l', '/w/l/c', '/w/a/rel', '/w/dangling', '/w/a/./f', '/w/a/../a/f', '/proc', '/proc/self',
	'/proc/1/status', '/dev', '/dev/null', '/sys', '/tmp', '/tmp/none', '/w/a/b/c/none',
	'/a/b/c/d/e/f/g/h/i', '/w/a/b/c/h/'
];
// the tty takes a line of 4095 bytes at most, so the stats go in short lines
const stats = async (paths: string[], flags = '') => {
	for (let i = 0; i < paths.length; i += 8)
		await command(
			paths
				.slice(i, i + 8)
				.map((p) => `stat ${flags} -c %i ${p} > /dev/null 2>&1`)
				.join('; ')
		);
};
await stats(PATHS);
await stats(PATHS, '-L');
// every prefix of the longer paths is a path too, so its own answer is known
await stats(
	['/w/a/b/c/g', '/usr/bin/env', '/w/a/f', '/bin/busybox'].flatMap((p) =>
		p.split('/').slice(1).map((_, i, parts) => `/${parts.slice(0, i + 1).join('/')}`)
	)
);

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IFDIR = 0o040000;
let compared = 0;
let kept = 0;
const problems: string[] = [];
for (const walk of walks.values()) {
	const { name } = walk;
	const parts = name.split('/').filter(Boolean);
	const prefixes = ['/', ...parts.map((_, i) => `/${parts.slice(0, i + 1).join('/')}`)];
	if (walk.inos) {
		kept++;
		walk.inos.forEach((ino, i) => {
			const known = answers.get(prefixes[i]!);
			// a prefix answered by a statx that followed a final symlink is the target's inode
			if (!known || (known.mode & S_IFMT) === S_IFLNK) return;
			compared++;
			if (known.ino !== ino) problems.push(`${name} prefix ${prefixes[i]}: walk ${ino}, kernel ${known.ino}`);
		});
		if (name.includes('/./') || name.includes('/../'))
			problems.push(`${name}: kept a walk through . or ..`);
	}
}
// a walk given up on must have a reason the kernel's answers show
let gaveUp = 0;
for (const walk of walks.values()) {
	const { name } = walk;
	if (walk.inos || (walk.result !== 0 && walk.result !== -2 && walk.result !== -20)) continue;
	gaveUp++;
	const parts = name.split('/').filter(Boolean);
	const dotted = parts.includes('.') || parts.includes('..');
	const crossing = /^\/(proc|sys|dev)(\/|$)/.test(name) || /^\/w\/a\/b\/c(\/|$)/.test(name);
	const prefixes = parts.map((_, i) => `/${parts.slice(0, i + 1).join('/')}`);
	const link = prefixes.some((p, i) => {
		const known = answers.get(p);
		const last = i === parts.length - 1 && walk.flags & 0x100 && !name.endsWith('/');
		return known && (known.mode & S_IFMT) === S_IFLNK && !last;
	});
	const lastLink = ((answers.get(prefixes.at(-1) ?? '/')?.mode ?? 0) & S_IFMT) === S_IFLNK;
	const nonDirInside = prefixes
		.slice(0, -1)
		.some((p) => answers.has(p) && (answers.get(p)!.mode & S_IFMT) !== S_IFDIR);
	const tooDeep = parts.length >= 8;
	if (!(dotted || crossing || link || lastLink || nonDirInside || tooDeep))
		problems.push(`${name}: gave up with result ${walk.result} for no reason the answers show`);
}
console.log(JSON.stringify({ walks: walks.size, kept, gaveUp, compared, problems: problems.length, crashed: String(machine.crashed) }));
for (const p of problems.slice(0, 20)) console.log(p);
process.exit(problems.length || !compared || machine.crashed ? 1 : 0);
