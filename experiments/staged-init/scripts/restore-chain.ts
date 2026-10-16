import { createHash } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostRuntime } from '../../../scripts/wasm/router-modules.ts';
import { bootstrapOf, type BootstrapIndex } from '../../../src/worker/bootstrap.ts';
import { Keeper, type KeeperHost } from '../../../src/worker/keeper.ts';
import { Machine } from '../../../src/worker/machine/machine.ts';
import { siteOptions } from '../../../src/worker/site-machine.ts';
import { sqlite } from '../../write-back/scripts/sqlite.ts';

/**
 * The deployed site's mid-job restore, without Cloudflare: the real Keeper and DurableStore over
 * SQLite, the site's machine options, and a clock that stands still and moves only when a storage
 * sync follows a write. The `survive` loop runs in turns of 5 s budget, each followed by a
 * checkpoint and an in-place resume (turns alternate attended and unattended); after TURNS
 * checkpoints the keeper is dropped, as a replaced object is, and a new one opens the stored
 * machine into the old machine's memory and again into a fresh one, each run to READY. Exit 1 on a
 * kernel panic, an rcu stall line, an OOM kill, a crash, a wrong count or no READY.
 * `GMUX_BUILD=<dir with kernel/ and router/> node --no-warnings --experimental-strip-types
 * restore-chain.ts` (N=9000000, TURNS=24, GAP_S=120, REOPEN=both|reuse|fresh, CAP_S=900,
 * CLOCK=frozen|live, RESUME=place|restore, CORE=0 for the TypeScript scheduler)
 */
const root = new URL('../../../', import.meta.url).pathname;
const build = process.env.GMUX_BUILD ?? join(root, 'build');
const N = Number(process.env.N ?? 9_000_000);
const TURNS = Number(process.env.TURNS ?? 24);
const GAP_S = Number(process.env.GAP_S ?? 120);
const CAP_S = Number(process.env.CAP_S ?? 900);
const REOPEN = process.env.REOPEN ?? 'both';
const FROZEN = (process.env.CLOCK ?? 'frozen') === 'frozen';
// the keeper continues a checkpointed machine in its own memory; `restore` has it restore the
// checkpoint into a new memory instead, as a successor would
if (process.env.RESUME === 'restore')
	Machine.resume = (options, snapshot) =>
		Machine.restore({ ...options, memory: undefined }, snapshot);
const kernel = (f: string) => readFileSync(join(build, 'kernel', f));
const manifest = JSON.parse(kernel('manifest.json').toString()) as {
	busybox: string;
	katybug: string;
	inputs?: string;
	image?: string;
};
const modules = {
	vmlinux: new WebAssembly.Module(kernel('vmlinux.async.wasm')),
	busybox: new WebAssembly.Module(kernel('busybox.async.wasm')),
	busyboxGuard: new WebAssembly.Module(kernel('busybox.guard.wasm')),
	katybug: new WebAssembly.Module(kernel('katybug.wasm')),
	runtime: hostRuntime(undefined, { core: process.env.CORE !== '0' }),
	initrd: new Uint8Array(kernel('initramfs.bin')),
	manifest
};

const BAD =
	/Kernel panic|rcu: INFO|rcu_sched (self-)?detected|Out of memory|Killed process|BUG:|Oops/;
const LOOP = `i=0; while [ $i -lt ${N} ]; do i=$((i+1)); [ $((i % 250000)) = 0 ] && echo P$i; done; echo READY $((i+0))\n`;

let output = '';
// where the phase being driven began in `output`
let mark = 0;
let gapNs = 0n;
let visible = BigInt(Date.now()) * 1_000_000n;
// a deployed Worker's clock moves at a storage sync that wrote, and not while code runs
const moveClock = () => void (visible = BigInt(Date.now()) * 1_000_000n + gapNs);
const clockNs = () => (FROZEN ? visible : BigInt(Date.now()) * 1_000_000n + gapNs);

const imageIndex = join(build, 'assets/_gmux/bootstrap/index.json');
const index = existsSync(imageIndex)
	? (JSON.parse(readFileSync(imageIndex, 'utf8')) as BootstrapIndex)
	: null;

function hostOver(db: ReturnType<typeof sqlite>, memory?: WebAssembly.Memory): KeeperHost {
	let alarm: number | null = null;
	let seen = db.written;
	return {
		sql: db,
		alarms: { getAlarm: () => alarm, setAlarm: (at) => void (alarm = at) },
		sync: async () => {
			if (db.written > seen) {
				seen = db.written;
				moveClock();
			}
		},
		now: () => Number(clockNs() / 1_000_000n),
		options: () => ({
			...siteOptions(modules, {
				memory,
				sha256: (bytes) => createHash('sha256').update(bytes).digest('hex'),
				digest: (algorithm) => createHash(algorithm),
				write: (text) => void (output += text)
			}),
			now: clockNs
		}),
		bootstrap: async () => {
			if (!index || index.image !== manifest.image) return null;
			const dir = join(build, 'assets/_gmux/bootstrap');
			return bootstrapOf(index, async (n) => new Uint8Array(readFileSync(join(dir, `c${n}.bin`))));
		}
	};
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 5)));
const bad = () => BAD.exec(output.slice(mark))?.[0] ?? null;
const ready = () => /READY (\d+)/.exec(output.slice(mark))?.[1];

interface Phase {
	name: string;
	ok: boolean;
	why: string | null;
	ready: string | null;
	turns: number;
	checkpoints: number;
	restores: number;
	wallS: number;
}

interface Typed {
	prompt: boolean;
	loop: boolean;
}

/** one event: the pump for a quantum, then the keeper's checkpoint (forced when it was not due) */
async function event(keeper: Keeper, unattended: boolean, typed: Typed) {
	const { machine } = await keeper.open();
	const stop = keeper.turn(5000, unattended);
	const started = Date.now();
	const outcome = await machine.run(() => {
		if (!typed.prompt) {
			typed.prompt = true;
			machine.type('\n');
		} else if (!typed.loop && /# $/.test(output.slice(mark))) {
			typed.loop = true;
			machine.type(LOOP);
		}
		return stop() || !!bad() || !!ready();
	}, keeper.sleeper(wait));
	if (outcome === 'crashed' || outcome === 'halted') return outcome;
	if (bad() || ready()) return outcome;
	const written = await keeper.ran(Date.now() - started, !unattended);
	if (!written && typed.loop) await keeper.checkpoint();
	return outcome;
}

async function drive(
	name: string,
	keeper: Keeper,
	typed: Typed,
	stopAt: (() => boolean) | null
): Promise<Phase> {
	const t0 = Date.now();
	let turns = 0;
	let why: string | null = null;
	while (!ready() && !why && (Date.now() - t0) / 1000 < CAP_S) {
		const outcome = await event(keeper, turns++ % 2 === 1, typed);
		if (outcome === 'crashed' || outcome === 'halted') why = `machine ${outcome}`;
		if (bad()) why = `console: ${bad()}`;
		if (!why && stopAt?.()) break;
	}
	const count = ready();
	if (!why && !stopAt) {
		if (!count) why = 'no READY';
		else if (Number(count) !== N) why = `count ${count}`;
	}
	return {
		name,
		ok: why === null,
		why,
		ready: count ?? null,
		turns,
		checkpoints: keeper.counts.checkpoints,
		restores: keeper.counts.restores,
		wallS: (Date.now() - t0) / 1000
	};
}

// what each checkpoint held, for the run that fails: runner, where it parked, idle, ready order
const held: string[] = [];
const checkpointed = Machine.prototype.checkpoint;
Machine.prototype.checkpoint = async function () {
	const entering = [...(this as unknown as { runners: Map<number, { name: string; interrupting?: boolean }> }).runners.values()]
		.filter((r) => r.interrupting)
		.map((r) => r.name);
	const snapshot = await checkpointed.call(this);
	const name = (i: number) => snapshot.runners[i]?.name ?? '?';
	held.push(
		`${snapshot.runners
			.map((r) => `${r.name}:${r.where}${r.user ? '+user' : ''}${r.idle ? '+idle' : ''}${r.started ? '' : '+new'}`)
			.join(' ')} | interrupting ${entering.join(',')} | ready ${(snapshot.readyAt ?? []).map(name).join(',')}`
	);
	return snapshot;
};
const showHeld = () => console.error(held.slice(-4).join('\n'));

const phases: Phase[] = [];
const live = sqlite();
let keeper = new Keeper(hostOver(live));
const chain = await drive(
	'chain',
	keeper,
	{ prompt: false, loop: false },
	() => keeper.counts.checkpoints >= TURNS && /P\d+/.test(output)
);
if (chain.ok && ready()) {
	chain.ok = false;
	chain.why = 'the loop ended before the chain did';
}
phases.push(chain);
if (chain.ok) {
	const memory = keeper.machine!.memory;
	const copy = join(tmpdir(), `restore-chain-${process.pid}.db`);
	live.exec('VACUUM INTO ?', copy);
	for (const mode of REOPEN === 'none' ? [] : REOPEN === 'both' ? ['reuse', 'fresh'] : [REOPEN]) {
		gapNs += BigInt(GAP_S) * 1_000_000_000n;
		moveClock();
		mark = output.length;
		keeper = new Keeper(hostOver(mode === 'reuse' ? live : sqlite(copy), mode === 'reuse' ? memory : undefined));
		phases.push(await drive(`reopen-${mode}`, keeper, { prompt: true, loop: true }, null));
		if (!phases.at(-1)!.ok) (showHeld(), console.error(output.slice(-1200)));
	}
	unlinkSync(copy);
} else (showHeld(), console.error(output.slice(-1200)));
const ok = phases.every((p) => p.ok);
console.log(
	JSON.stringify({ kernel: manifest.inputs?.slice(0, 12) ?? build, frozen: FROZEN, N, phases, ok })
);
process.exit(ok ? 0 : 1);
