import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendCpio } from '../../../scripts/wasm/cpio-append.ts';
import {
	decodeSnapshot,
	DurableStore,
	encodeSnapshot,
	type Recovery
} from '../../../src/worker/durable.ts';
import { Machine, type MachineOptions } from '../../../src/worker/machine/machine.ts';
import { sqlite } from './sqlite.ts';

/**
 * Durability is exact across a lost machine. The booted kernel checkpoints; a job then fsyncs a
 * file and writes another it never syncs, writes a file opened O_SYNC (programs/osync.wat), stores
 * into a shared mapping and msyncs it with MS_SYNC (programs/mapped.wat), and closes a file it
 * never syncs. The machine is dropped with no second checkpoint. The restore takes the checkpoint
 * and the synced files: the fsynced, O_SYNC and msynced files read back byte for byte, the unsynced
 * and the closed ones do not exist, and the store never got the closed one (close is no sync on
 * Linux). A second job writes a file and removes a synced one, then calls sync: after a second
 * loss the first is there and the second is not. Controls, each of which must fail: `--skip-files`
 * leaves the synced files out of the restore, `--no-osync` opens without O_SYNC, `--no-msync`
 * msyncs with MS_ASYNC.
 * `node --experimental-strip-types experiments/write-back/scripts/fsync-exact.ts` (after boot stage.sh)
 */
const root = new URL('../../../', import.meta.url).pathname;
const vendor = join(root, 'experiments/boot/vendor');
const read = (name: string) => new Uint8Array(readFileSync(join(vendor, name)));
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(readFileSync(join(root, 'build/kernel/manifest.json'), 'utf8'));
const skipFiles = process.argv.includes('--skip-files');
const O_SYNC = 0o4010000;
const MS_SYNC = 4;
const MS_ASYNC = 1;

// the two programs, assembled with their flags, in the initramfs and the registry
const work = mkdtempSync(join(tmpdir(), 'fsync-exact-'));
const programs = new Map<string, WebAssembly.Module>();
const pairs: string[] = [];
for (const [name, flags] of [
	// O_WRONLY | O_CREAT | O_TRUNC
	['osync', 0o1101 | (process.argv.includes('--no-osync') ? 0 : O_SYNC)],
	['mapped', process.argv.includes('--no-msync') ? MS_ASYNC : MS_SYNC]
] as const) {
	const source = join(work, `${name}.wat`);
	const text = readFileSync(new URL(`../programs/${name}.wat`, import.meta.url), 'utf8');
	writeFileSync(source, text.replace('(i32.const FLAGS)', `(i32.const ${flags})`));
	execFileSync('wasm-tools', ['parse', source, '-o', join(work, `${name}.wasm`)]);
	const bytes = new Uint8Array(readFileSync(join(work, `${name}.wasm`)));
	programs.set(sha256(bytes), new WebAssembly.Module(bytes));
	pairs.push(`/bin/${name}=${join(work, `${name}.wasm`)}`);
}
appendCpio(join(vendor, 'initramfs.bin'), join(work, 'initramfs.bin'), pairs);
const initrd = new Uint8Array(readFileSync(join(work, 'initramfs.bin')));

const sql = sqlite();
const store = new DurableStore(sql);
let output = '';
let synced = 0;
const faults: string[] = [];
// every phase's console, for TRANSCRIPT=<file> when the check fails
let transcript = '';
const base = (): MachineOptions => ({
	vmlinux: new WebAssembly.Module(read('vmlinux.async.wasm')),
	initrd,
	cmdline: 'maxcpus=3 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0',
	registry: new Map([
		[manifest.busybox, new WebAssembly.Module(read('busybox.async.wasm'))],
		...programs
	]),
	maximumPages: 800,
	sha256,
	sharedKernel: true,
	asyncify: true,
	write: (text) => {
		output += text;
		transcript += text;
	},
	log: (l) => void (/ fault: /.test(l) && faults.push(l)),
	fileSync: async (file) => {
		store.writeFile(file);
		synced++;
	}
});
const run = (m: Machine, until: () => boolean, ms = 120_000) => {
	const t = Date.now();
	return m.run(
		() => until() || Date.now() - t > ms,
		(x) => new Promise((r) => setTimeout(r, Math.min(x, 20)))
	);
};
const command = async (m: Machine, cmd: string, marker: string) => {
	const mark = output.length;
	m.type(`${cmd}; echo ${marker}\n`);
	await run(m, () => output.slice(mark).includes(`\n${marker}`));
	return output.slice(mark).replaceAll('\r', '');
};

let machine = new Machine(base());
await run(machine, () => output.includes('# '));
await command(machine, 'mkdir -p /data; echo base > /data/base', '@@A@@');
const snapshot = await machine.checkpoint();
const first = store.writeCheckpoint(snapshot.memory, encodeSnapshot(snapshot));
const restore = async (recovery: Recovery, files = true) =>
	Machine.restore(
		{ ...base(), restoreFiles: files ? recovery.files : [] },
		decodeSnapshot(recovery.snapshot),
		recovery.image
	);
machine = await restore(store.recover()!);

// the synced file is 300 KB of lines, rewritten once so a block changes between its two syncs
const expected = new TextEncoder().encode(
	Array.from({ length: 40000 }, (_, i) => `${i + 1}`).join('\n') + '\n'
);
const job = await command(
	machine,
	'seq 1 40000 > /data/log; fsync /data/log; echo 2 > /data/log.tmp; ' +
		'seq 1 40000 > /data/log; fsync /data/log; seq 1 99 > /data/nosync; ' +
		'/bin/osync; echo "osync rc $?"; /bin/mapped; echo "mapped rc $?"; ' +
		'echo closed > /data/closed; cat /data/closed',
	'@@B@@'
);
const kept = store.recover()!;
const storeCopy = kept.files.find((f) => f.path === '/data/log');
machine = null as unknown as Machine;

output = '';
machine = await restore(kept, !skipFiles);
const after = await command(
	machine,
	'sha256sum /data/log; ls /data; cat /data/base; cat /data/osync; head -n 1 /data/mapped',
	'@@C@@'
);

// sync: every changed file goes, and one synced since the checkpoint and removed goes as removed
const walk = await command(
	machine,
	'echo walked > /data/walked; echo gone > /data/gone; fsync /data/gone; rm /data/gone; sync',
	'@@D@@'
);
const walked = store.recover()!;
const walks = machine.stats.syncWalks;
machine = null as unknown as Machine;
output = '';
machine = await restore(walked, !skipFiles);
const afterWalk = await command(machine, 'cat /data/walked; ls /data', '@@E@@');

const listing = (text: string) => text.split('\n').filter((l) => /^[a-z.]+$/.test(l));
const result = {
	checkpointRows: first.rows,
	checkpointChanged: first.changed,
	syncs: synced,
	storeRowsWritten: sql.written,
	filesRecovered: kept.files.map((f) => `${f.path}:${f.bytes.byteLength}`),
	storeCopyExact: storeCopy ? sha256(storeCopy.bytes) === sha256(expected) : false,
	logExact: after.includes(`${sha256(expected)}  /data/log`),
	nosyncAbsent: !listing(after).includes('nosync'),
	baseKept: after.includes('\nbase'),
	programsRan: job.includes('osync rc 0') && job.includes('mapped rc 0'),
	osyncKept: after.includes('osync line one\nosync line two\n'),
	mappedKept: after.includes('\nmapped line'),
	// close: the kernel kept the file open or not, and nothing reached the store for it
	closeKeeps: job.includes('\nclosed'),
	closeNoFlush:
		!kept.files.some((f) => f.path === '/data/closed') && !listing(after).includes('closed'),
	syncWalks: walks,
	faults,
	walkedKept: afterWalk.includes('\nwalked'),
	removedAbsent: !listing(afterWalk).includes('gone'),
	restoredStats: {
		filesRestored: machine.stats.filesRestored,
		errors: machine.stats.fileRestoreErrors
	},
	jobTail: job.slice(-120),
	walkTail: walk.slice(-80)
};
console.log(JSON.stringify(result, null, 1));
const pass =
	result.storeCopyExact &&
	result.logExact &&
	result.nosyncAbsent &&
	result.baseKept &&
	result.programsRan &&
	result.osyncKept &&
	result.mappedKept &&
	result.closeKeeps &&
	result.closeNoFlush &&
	result.walkedKept &&
	result.removedAbsent &&
	!faults.length;
console.log(pass ? 'PASS durability exact' : 'FAIL durability exact');
if (!pass && process.env.TRANSCRIPT) writeFileSync(process.env.TRANSCRIPT, transcript);
process.exit(pass ? 0 : 1);
