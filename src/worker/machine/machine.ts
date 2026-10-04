import { coreRegionPages, loadCore, type Core } from './core.ts';
import { DlProcess, dylinkInfo, type DlMisses, type DlSaved, type DlView } from './dl.ts';
import { clear, copyIn, copyOut, Domain, EFAULT, READ, stringLength, WRITE } from './domain.ts';
import { Ingress, type IngressStream } from './ingress.ts';
import {
	MISS,
	ROUTE_HOOK,
	ROUTE_KERNEL,
	ROUTE_WATCH,
	ROUTE_WRITES,
	STATX_GUARDS,
	statxBucket,
	StatxTable,
	WRITE_CALLS,
	type RouterModules
} from './router.ts';

/** a regular file as a program's fsync left it, or as a restore writes it back */
export interface SyncedFile {
	/** its absolute path in the machine */
	path: string;
	/** its permission bits */
	mode: number;
	/** its whole contents */
	bytes: Uint8Array;
	/** a sync(2) found it gone: a restore removes it */
	removed?: boolean;
}

/** one syscall as `countSyscalls` hands it to a function */
export interface SyscallCall {
	/** the calling task's runner id */
	task: number;
	nr: number;
	args: number[];
	/** the kernel's return value, null when the call is reported before it runs */
	ret: number | null;
	/** the NUL-terminated string at a user address, in the caller's memory */
	string(address: number): string;
}

/**
 * what a machine is built from: the kernel, its initramfs and command line, the programs it may run
 */
export interface MachineOptions {
	/** the kernel, compiled (`kernel/vmlinux.wasm`) */
	vmlinux: WebAssembly.Module;
	/** the initramfs the kernel unpacks as its root filesystem (`kernel/initramfs.bin`) */
	initrd: Uint8Array;
	/** the kernel command line; boot without `nohz_full` (see the technical report) */
	cmdline: string;
	/**
	 * `gmux-core.wasm`, compiled (scripts/build-core.sh): the scheduler's idle table and deadline
	 * minimum run in C over the machine's memory, in pages reserved before the kernel boots. Without
	 * it the same decisions run in TypeScript
	 */
	core?: WebAssembly.Module;
	/** precompiled user programs keyed by the hex SHA-256 of their bytes */
	registry: Map<string, WebAssembly.Module>;
	/**
	 * a program made shareable by scripts/wasm/share.ts runs every process on one instance, its
	 * bases, stack pointer and globals swapped at each switch (needs `sharedKernel`; no checkpoints)
	 */
	shareInstances?: boolean;
	/**
	 * builds of the registry's programs that check every load and store against the kernel's page
	 * owner table (scripts/wasm/guard-pass.ts), by the same hash. A task whose effective uid is not 0 runs
	 * these, and one with no guarded build for its program cannot run it
	 */
	guarded?: Map<string, WebAssembly.Module>;
	/** the most 64 KiB pages the machine's memory may grow to (default 2048); the kernel takes it all as RAM */
	maximumPages?: number;
	/** the host clock in nanoseconds since the Unix epoch (default `Date.now()`) */
	now?: () => bigint;
	/** host diagnostics: faults, crashes, and with `trace` every switch */
	log?: (line: string) => void;
	/** console output, as the kernel writes it */
	write?: (text: string) => void;
	/** the hex SHA-256 of an executable without an exec stub, to find it in `registry` */
	sha256: (bytes: Uint8Array) => string;
	/** log every task switch and release through `log` */
	trace?: boolean;
	/**
	 * called on a software-TLB miss for a page of a program built with scripts/wasm/mmu-pass.ts; a
	 * promise parks the task until the page is in place (a lazy restore faulting pages in). With
	 * canWait false the program runs outside WebAssembly.promising (its start function, relocations
	 * and constructors), so the page must be in place before this returns
	 */
	pageIn?: (page: number, canWait: boolean) => Promise<void> | undefined;
	/**
	 * a memory to boot or restore into instead of a new one, zeroed first; its maximum must equal
	 * maximumPages. An evicted machine's memory stays charged to its isolate, so a successor in the
	 * same isolate reuses it rather than allocating a second. A memory larger than the machine
	 * starts with is declined: the kernel takes everything past its start size as RAM, so this serves
	 * restores (a snapshot is full size) and not boots after one
	 */
	memory?: WebAssembly.Memory;
	/** loop iterations a user program runs between host yields */
	fuelBudget?: number;
	/**
	 * milliseconds after `Machine.restore` at which each restored evacuable program, at its next fuel
	 * yield, spills its frames and resumes them in its own instance. A running wasm frame keeps the
	 * code it was entered with, so frames a restore rebuilt in freshly compiled code continue in what
	 * V8 has optimized since. Once per program; nothing is copied
	 */
	reenterAfterRestore?: number;
	/** pump steps between macrotask yields, so a frozen host clock can advance */
	yieldEvery?: number;
	/** how far the kernel's clock moves per scheduling decision when the host clock does not */
	stepNs?: bigint;
	/**
	 * one vmlinux instance for every task, switching the task's mutable globals at each park and
	 * resume; needs a vmlinux that exports them (scripts/export-globals.ts)
	 */
	sharedKernel?: boolean;
	/**
	 * the kernel and user modules are asyncified at their park imports (scripts/build-async.sh), so
	 * `checkpoint()` can turn every parked stack into bytes and `Machine.restore()` can rewind it
	 */
	asyncify?: boolean;
	/**
	 * called when a program fsyncs or fdatasyncs a regular file, with the file as the kernel reads
	 * it; the program's call returns once this resolves, so resolve once the bytes are durable.
	 * Without it (and without `restoreFiles`) programs call the kernel directly
	 */
	fileSync?: (file: SyncedFile) => Promise<void>;
	/**
	 * for `Machine.restore`: files synced after the snapshot was taken, written into the machine at
	 * the first syscall any program makes, before that syscall runs
	 */
	restoreFiles?: SyncedFile[];
	/**
	 * answers a repeated statx of an absolute path from the host while the kernel's path-query
	 * generation (kernel patch 0022) and the task's view are what they were, without entering the
	 * kernel. 'verify' asks the kernel every time and counts answers the cache would have got wrong
	 */
	syscallCache?: boolean | 'verify';
	/**
	 * routes every syscall through the host hook, which counts it by number in `stats.syscalls`; a
	 * function is also called for each (before it for the calls that may not return, else after). Exact
	 * counts, but every call pays a host crossing, so a run under it is not timed
	 */
	countSyscalls?: boolean | ((call: SyscallCall) => void);
	/**
	 * the syscall router and the statx hit path, compiled (`scripts/build-router.sh`); required with
	 * `fileSync`, `restoreFiles`, `syscallCache` or `countSyscalls`
	 */
	router?: RouterModules;
	/**
	 * wasm side modules a process asked for that the registry did not hold, by executable hash. Pass
	 * the same map to the next machine to carry the record across runs
	 */
	dlMisses?: DlMisses;
	/**
	 * the interpreted tier: the module that runs `exe` with its recorded `libs` interpreted, or
	 * undefined when it cannot take them. Absent, a recorded miss is refused again
	 */
	interpret?: (exe: string, libs: string[]) => WebAssembly.Module | undefined;
}

/**
 * how a task started: the boot cpu, a secondary cpu idling on its task, or a fork from `prev` to
 * `next`
 */
export type Entry =
	| { kind: 'boot' }
	| { kind: 'secondary'; idle: number }
	| { kind: 'fork'; prev: number; next: number };

/** one kernel task in a snapshot: where it parked and the stacks it unwound into bytes */
export interface SavedRunner {
	/** the task's `task_struct` address (a cpu's: its idle task's) */
	id: number;
	/** the task's name when it was created, for logs */
	name: string;
	/** how the task started: the boot cpu, a secondary cpu, or a fork */
	entry: Entry;
	/** whether its first entry into the kernel has run */
	started: boolean;
	/** the value its park returns when it resumes */
	value: number;
	/** `remaining` is null for no deadline; an overdue deadline is saved as 0 */
	idle: { word: number; remaining: string | null } | null;
	/** whether it stopped the machine */
	halted: boolean;
	/** whether it was released while running and ends at its next park */
	kill: boolean;
	/** its values of the shared kernel instance's five task globals, put back before it resumes */
	saved: number[] | null;
	/** the side of the syscall boundary it parked on */
	where: 'kernel' | 'user' | null;
	/** the program it runs: registry hash, data and table bases */
	user: { hash: string; dataStart: number; tableStart: number } | null;
	/** the program instance's entry, stack pointer and exported mutable globals */
	program: { entry: 'start' | 'clone'; stackPointer: number; globals: [string, number][] } | null;
	/** the kernel frames of its park, as asyncify data */
	kernelStack: Uint8Array | null;
	/** its user frames: asyncify data, or an evacuated program's spilled frames */
	userStack: Uint8Array | null;
	/** the page owner tag of its process (kernel patch 0014), for a lazy restore */
	tag?: number;
	/** a signal handler parked on a stack of its own, unwound before the frames it interrupted */
	signal?: HandlerStacks | null;
	/** the kernel released it while it still had a turn in the ready queue to take */
	released?: boolean;
}

/** a signal handler parked on its own stack, in a snapshot */
export interface HandlerStacks {
	/** the signal flow the handler runs for */
	flow: number;
	/** the side of the syscall boundary it parked on */
	where: 'kernel' | 'user' | null;
	/** its kernel frames, as asyncify data */
	kernel: Uint8Array | null;
	/** its user frames */
	user: Uint8Array;
}

/** built by experiments/evacuation/scripts/evacuate.ts --resume: checkpoints without asyncify */
function evacuable(exports: Record<string, any>): boolean {
	return 'gmux_ckpt' in exports;
}

/** everything a machine needs to continue in a fresh isolate: linear memory plus host state */
export interface Snapshot {
	/** the snapshot format */
	version: 1;
	/** the machine's linear memory: a view over the live memory until the caller copies it */
	memory: Uint8Array;
	/** where the unwind scratch region sat in memory */
	scratch: number;
	/** where the C core's region sat in memory, when the machine ran one */
	core?: number;
	/** the kernel clock at checkpoint, in nanoseconds as a decimal string */
	now: string;
	/** console input not yet read */
	input: number[];
	/** tasks ready to run, in order, by id */
	ready: number[];
	/** the same, by index into `runners`: a released task's id may name a newer task */
	readyAt?: number[];
	/** the boot cpu's id */
	cpuZero: number;
	/** every task, parked */
	runners: SavedRunner[];
	/** the counters at checkpoint */
	stats: MachineStats;
	/** processes' dlopen'ed side modules */
	dl?: DlSaved[];
	/** the kernel's page owner tags at checkpoint, which a lazy restore defers pages by */
	owners?: Uint16Array;
	/** a program had opened a file with O_DSYNC */
	syncWrites?: boolean;
	/** the ports programs listened on (kernel patch 0031), once per listener */
	ports?: number[];
}

// asyncify buffers live in linear memory only while a stack unwinds or rewinds
/** the cpu the kernel takes device interrupts on (asm/processor.h) */
const IRQ_CPU = 1;
const SCRATCH_PAGES = 32;
const STACK_BYTES = (SCRATCH_PAGES / 2) * 0x10000;

// vmlinux's only mutable globals; everything else a task needs is in linear memory
const TASK_GLOBALS = ['gmux_sp', 'gmux_tls', 'gmux_current', 'gmux_usp', 'gmux_utls'];

const SYS_EXIT_GROUP = 94;
const SYS_TKILL = 130;
const SYS_RT_SIGACTION = 134;
const SYS_RT_SIGPROCMASK = 135;
const SYS_GETPID = 172;
const SYS_GETTID = 178;
const SYS_CLONE = 220;
const SYS_EXECVE = 221;
const SYS_MUNMAP = 215;
const SYS_MMAP = 222;
const SYS_PRLIMIT64 = 261;
const SYS_MKDIRAT = 34;
const SYS_OPENAT = 56;
const SYS_CLOSE = 57;
const SYS_READ = 63;
const SYS_WRITE = 64;
const SYS_READLINKAT = 78;
const SYS_FSYNC = 82;
const SYS_FDATASYNC = 83;
const SYS_STATX = 291;
const STATX_MNT_ID = 0x1000;
const STATX_TYPE = 0x1;
const STATX_INO = 0x100;
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const SYS_FCNTL = 25;
const SYS_UNLINKAT = 35;
const SYS_GETDENTS64 = 61;
const SYS_SPLICE = 76;
const SYS_SYNC = 81;
const SYS_SYNC_FILE_RANGE = 84;
const SYS_MSYNC = 227;
const SYS_SYNCFS = 267;
const SYS_COPY_FILE_RANGE = 285;
const SYS_PWRITEV2 = 287;
const F_GETFL = 3;
const O_DSYNC = 0o10000;
const O_DIRECTORY = 0o200000;
const AT_SYMLINK_NOFOLLOW = 0x100;
const MS_SYNC = 4;
const RWF_DSYNC = 2;
const RWF_SYNC = 4;
const DT_DIR = 4;
const DT_REG = 8;
const AT_FDCWD = -100;
const AT_EMPTY_PATH = 0x1000;
const O_RDONLY = 0;
const O_WRONLY = 1;
const O_CREAT = 0o100;
const O_TRUNC = 0o1000;
const O_CLOEXEC = 0o2000000;
const RLIMIT_STACK = 3;
// a split stack grows by this much at a time (scripts/wasm/stack-pass.ts)
const STACK_SEGMENT = 1 << 20;
// room left under the checked limit for the small leaf frames the stack pass does not check
const STACK_GUARD = 4096;
const CLONE_VM = 0x100;
const CLONE_VFORK = 0x4000;
const SIGILL = 4;
const SIGABRT = 6;
const SIGFPE = 8;
const SIGSEGV = 11;
const SIGCHLD = 17;
// the mapping a forking program's frames spill into, one per process
const FORK_SPILL = 1 << 20;
const SIG_UNBLOCK = 1;

/**
 * a vfork in flight (src/gmux/vfork.c): the child runs on the parent's user stack as the child task,
 * and its execve or _exit runs on a stack of its own, so the parent can take its frames back
 */
/** a fork's parent frames, spilled once, which its parent and its child both resume */
interface Fork {
	parent: Runner;
	/** the spilled frames end here; they sit in the parent's memory, and so in the child's copy */
	top: number;
	sp: number;
	entry: 'start' | 'clone';
	/** the parent's exported mutable globals (scripts/wasm/export-globals.ts) */
	globals: [string, number][];
	segments?: { low: number; high: number }[];
	segment?: number;
}

interface Vfork {
	parent: Runner;
	child: Runner | null;
	/** the parent's jmp_buf, for the longjmp the host throws if the child dies holding the stack */
	env: number;
	/** the user stack pointer the parent's clone passed, which the child starts with */
	sp: number;
	/** resolves the parent's __gmux_vfork; 0 continues its stack as the child */
	start: (value: number) => void;
	/** the shared stack parked in __gmux_vfork_exec or _exit; the child's pid hands it to the parent */
	borrowed: ((value: number) => void) | null;
}

type Resume = (value: number) => void;

/** a cpu parked on an interrupt word (an address) until it is raised or a deadline (negative: none) passes */
interface Idle {
	word: number;
	deadline: bigint;
	runner: Runner;
}

interface Runner {
	name: string;
	instance: WebAssembly.Instance | null;
	/** how to continue this runner when the pump picks it */
	resume: Resume | null;
	/** the value handed to `resume` */
	value: number;
	idle: Idle | null;
	halted: boolean;
	kill: boolean;
	user: {
		module: WebAssembly.Module;
		hash: string;
		dataStart: number;
		tableStart: number;
	} | null;
	/** the shared instance its program runs on, and its values there while it is parked */
	shared?: SharedProgram | null;
	sharedSaved?: number[] | null;
	/** the running user program, for signal delivery */
	program: {
		exports: Record<string, any>;
		stackPointer: WebAssembly.Global;
		entry: 'start' | 'clone';
		/** made for a signal the task took on its way to user mode, before its entry ran */
		early?: boolean;
		/** the stack's segments in stack order (scripts/wasm/stack-pass.ts), the first where the kernel put it */
		segments?: { low: number; high: number }[];
		/** the segment the stack pointer is in */
		segment?: number;
		/** its dlopen'ed side modules */
		dl?: DlView;
	} | null;
	/** task globals saved at park, with a shared kernel instance */
	saved: number[] | null;
	id: number;
	/** the runner's place in creation order, which is the order `runners` lists them in */
	seq: number;
	/** its entry in the C core's tables, from the first idle wait until it is released */
	slot: number;
	entry: Entry;
	started: boolean;
	/** which instance's import the stack is parked in */
	where: 'kernel' | 'user' | null;
	unwinding: boolean;
	rewinding: boolean;
	/** its stack is in the snapshot; a late continuation of its entry must do nothing */
	checkpointed: boolean;
	/** throws into the parked stack instead of resuming it */
	fail: ((error: unknown) => void) | null;
	/** a vfork this runner started and is waiting on */
	vfork: Vfork | null;
	/** the vfork whose child this runner is, while it holds the parent's stack */
	vforkOf: Vfork | null;
	/** its process's page owner tag, when a lazy restore has its pages to bring in */
	tag?: number;
	/** inside the syscall router's host hook, whose JS frame a checkpoint cannot carry */
	syncing?: boolean;
	/** its frames are spilling for a fork */
	forking?: boolean;
	/** what the re-issued __gmux_fork of its resumed frames returns: the child's pid, or 0 in the child */
	forkResult?: number;
	/** the stack pointer its fork was called with */
	forkSp?: number;
	/** the fork this runner is the child of, until its frames resume */
	forkOf?: Fork | null;
	/** with `reenterAfterRestore`: the host time from which its next fuel yield re-enters its frames */
	reenterAt?: bigint;
	/** its frames are spilling to resume in their own instance */
	reentering?: boolean;
	/** the stack pointer of the fuel yield it re-enters at */
	reenterSp?: number;
	/** what the re-issued __gmux_fuel of its re-entered frames returns */
	reentered?: number;
	/** signal handlers running on stacks of their own */
	handlers: number;
	/** inside a kernel entry of userInterrupt's, whose JS frame a checkpoint cannot carry */
	interrupting?: boolean;
	/** the handler a checkpoint unwound, or a restore has yet to rewind */
	signal?: HandlerStacks | null;
}

/** the function table a program needs (scripts/wasm/table-note.ts), or 4096 without the note */
/** one instance for every process running a program */
interface SharedProgram {
	exports: Record<string, any>;
	memoryBase: WebAssembly.Global;
	stackPointer: WebAssembly.Global;
	/** what a switch saves and restores: the memory base, the stack pointer and the exported mutable globals */
	globals: WebAssembly.Global[];
	/** the exported globals after the first process's start, where every later process begins */
	initial: number[];
	/** the main thread's TLS block, from the data start */
	tlsOffset: number;
	/** the data image before relocation, copied to each new process's data start */
	template: Uint8Array | null;
	tableStart: number;
}

function shareable(module: WebAssembly.Module): boolean {
	return WebAssembly.Module.customSections(module, 'gmux.share').length > 0;
}

/** a shareable program's data and bss, from its gmux.share section */
function sharedDataSize(module: WebAssembly.Module): number {
	return new DataView(WebAssembly.Module.customSections(module, 'gmux.share')[0]!).getUint32(
		0,
		true
	);
}

/** the registry key an exec stub carries (scripts/wasm/exec-stubs.ts), or null for a full file */
export function stubHash(bytes: Uint8Array): string | null {
	let p = 8;
	const leb = () => {
		let n = 0;
		for (let shift = 0; ; shift += 7) {
			const b = bytes[p++] ?? 0;
			n |= (b & 0x7f) << shift;
			if (b < 0x80) return n >>> 0;
		}
	};
	if (bytes[p++] !== 0) return null;
	const dylink = leb();
	p += dylink;
	if (bytes[p++] !== 0) return null;
	const end = leb() + p;
	const name = leb();
	if (end !== bytes.length || end - p - name !== 32) return null;
	if (String.fromCharCode(...bytes.subarray(p, p + name)) !== 'gmux.exec') return null;
	return Array.from(bytes.subarray(end - 32), (b) => b.toString(16).padStart(2, '0')).join('');
}

function tableEntries(module: WebAssembly.Module): number {
	const note = WebAssembly.Module.customSections(module, 'gmux.table')[0];
	return note ? new DataView(note).getUint32(0, true) : 4096;
}

/** a trap in wasm code, or its stack running out; not an error the host threw */
function isFault(error: unknown): boolean {
	if (error instanceof WebAssembly.RuntimeError) return true;
	return error instanceof RangeError && /call stack size/.test(error.message);
}

/**
 * FNV-1a over an absolute path's bytes in `mem` from `at`, with the view, flags and mask folded in;
 * null for a relative or unterminated path. statx.wat's `key` is the same function
 */
export function statxHash(mem: Uint8Array, at: number, view: number, flags: number, mask: number) {
	if (mem[at] !== 0x2f) return null;
	let h = (0x811c9dc5 ^ view ^ Math.imul(flags, 0x9e3779b1) ^ Math.imul(mask, 0x85ebca6b)) >>> 0;
	for (let i = at; i < at + 4096 && i < mem.length; i++) {
		const b = mem[i]!;
		if (!b) return h;
		h = Math.imul(h ^ b, 16777619) >>> 0;
	}
	return null;
}

class Trap extends Error {
	readonly kind: string;
	constructor(kind: string) {
		super(`host trap ${kind}`);
		this.kind = kind;
	}
}

/**
 * thrown into the parked stack of a task the kernel released, which nothing will resume: V8 keeps a
 * suspended stack and every instance on it, so a stack left parked is memory an exited process never
 * gives back
 */
class Abandoned extends Error {}

/** counters the host keeps while a machine runs */
export interface MachineStats {
	/** task switches the kernel asked for */
	switches: number;
	/** `cpu_relax` calls: a spinning cpu giving up the host thread */
	relaxes: number;
	/** idle waits: a cpu with nothing to run parked on its interrupt word */
	idles: number;
	/** runners created: cpus and kernel tasks */
	runners: number;
	/** wasm instances created, kernel and user */
	instances: number;
	/** entries into user programs: execs and new threads */
	userExecs: number;
	/** signal handlers run */
	signals: number;
	/** fuel yields: a user loop giving up the host thread */
	fuelYields: number;
	/** software-TLB misses in programs built with scripts/wasm/mmu-pass.ts */
	mmuMisses: number;
	/** misses that parked a task until the host brought its page in */
	pageFaults: number;
	/** stack segments mapped for split stacks */
	stackSegments: number;
	/** forks through __gmux_fork */
	forks: number;
	/** restored programs whose frames resumed again in their own instance (`reenterAfterRestore`) */
	reentries: number;
	/** pages a lazy restore left out */
	deferredPages: number;
	/** deferred pages brought in since */
	filledPages: number;
	/** of those, pages the kernel reached for another process first (kernel patch 0021) */
	touchedPages: number;
	/** free pages the last checkpoint zeroed instead of saving (kernel patch 0020) */
	freePages: number;
	/** restores the kernel was told of: crng rekeyed, stall detectors reset (kernel patch 0023) */
	restoreHooks: number;
	/** processes that joined a shared program instance instead of instantiating */
	sharedEntries: number;
	/** the console driver's reads from the host */
	consoleReads: number;
	/** input interrupts raised to the console */
	consoleRaises: number;
	/** executables the registry did not hold, by hash and size */
	unknownExecutables: string[];
	/** side modules a process asked dlopen for that the registry did not hold: library hash for executable hash */
	dlMisses: string[];
	/** executables started on the interpreted tier because an earlier run recorded a miss */
	interpretedStarts: string[];
	/** regular files handed to `fileSync` by an fsync, a synchronous write, an msync or a sync */
	fileSyncs: number;
	/** sync and syncfs calls, each a walk of the root filesystem */
	syncWalks: number;
	/** parked stacks of released tasks, unwound so they can be collected */
	abandonedStacks: number;
	/** statx answered from the host's cache, asked of the kernel for want of an answer, and stored */
	statxHits: number;
	statxMisses: number;
	statxFills: number;
	/** the fills held on inode counters (kernel patch 0029) and the probes they and the others cost */
	statxFineFills: number;
	statxProbes: number;
	/** with `syscallCache: 'verify'`: answers the cache held that the kernel then contradicted */
	statxMismatches: number;
	/** with `countSyscalls`: calls by syscall number */
	syscalls: Record<number, number>;
	/** host crossings into a fork child's own memory, and the bytes they moved */
	userCopies: number;
	userCopyBytes: number;
	/** strings read from it in one crossing each (the kernel's strncpy_from_user and strnlen_user), and the bytes copied */
	userStrings: number;
	userStringBytes: number;
	/** files a sync found gone since they were synced, handed to `fileSync` as removed */
	fileRemovals: number;
	/** the bytes those handed over */
	fileSyncBytes: number;
	/** syncs of a file with no path to name it by (deleted, or not a regular file), passed through */
	fileSyncsSkipped: number;
	/** streams opened to the machine's listeners, and the events the relay thread took */
	netOpens: number;
	netEvents: number;
	/** the relay's sends to the host, the bytes it took from the host, the bytes the guest sent, and the sends the host could not take */
	netSends: number;
	netBytesIn: number;
	netBytesOut: number;
	netBackpressure: number;
	/** `restoreFiles` written back */
	filesRestored: number;
	/** `restoreFiles` the kernel refused, with its error */
	fileRestoreErrors: string[];
}

/**
 * A Linux machine on one host thread.
 *
 * Every kernel task and every CPU is one vmlinux instance over one shared memory, as in linux-wasm.
 * Blocking host imports are JSPI `Suspending` functions and every call into wasm that can block goes
 * through `WebAssembly.promising`, so a pump can run exactly one task at a time and switch by
 * resolving the task the kernel names next.
 */
export class Machine {
	/** the one memory the kernel and every process share */
	readonly memory: WebAssembly.Memory;
	private readonly runners = new Map<number, Runner>();
	private readonly ready: Runner[] = [];
	private current: Runner | null = null;
	private suspended: ((r: Runner) => void) | null = null;
	private input: number[] = [];
	private readonly decoder = new TextDecoder();
	private cpuZero: Runner;
	/** counters, updated as the machine runs */
	readonly stats: MachineStats = {
		switches: 0,
		relaxes: 0,
		idles: 0,
		runners: 0,
		instances: 0,
		userExecs: 0,
		signals: 0,
		fuelYields: 0,
		mmuMisses: 0,
		pageFaults: 0,
		stackSegments: 0,
		forks: 0,
		reentries: 0,
		deferredPages: 0,
		filledPages: 0,
		touchedPages: 0,
		freePages: 0,
		restoreHooks: 0,
		sharedEntries: 0,
		consoleReads: 0,
		consoleRaises: 0,
		unknownExecutables: [],
		dlMisses: [],
		interpretedStarts: [],
		fileSyncs: 0,
		syncWalks: 0,
		abandonedStacks: 0,
		statxHits: 0,
		statxMisses: 0,
		statxFills: 0,
		statxFineFills: 0,
		statxProbes: 0,
		statxMismatches: 0,
		syscalls: {},
		userCopies: 0,
		userCopyBytes: 0,
		userStrings: 0,
		userStringBytes: 0,
		fileRemovals: 0,
		fileSyncBytes: 0,
		fileSyncsSkipped: 0,
		netOpens: 0,
		netEvents: 0,
		netSends: 0,
		netBytesIn: 0,
		netBytesOut: 0,
		netBackpressure: 0,
		filesRestored: 0,
		fileRestoreErrors: []
	};
	/** the streams hosts open to the machine's listeners (kernel patch 0031) */
	private readonly net = new Ingress(this.stats, () => this.raiseNet());
	/** whether the kernel halted (`reboot`, `poweroff`) */
	halted = false;
	/** the error that stopped the machine, if one did */
	crashed: unknown = null;

	private readonly options: MachineOptions;
	private running = false;
	// its stacks are bytes in a snapshot; only Machine.restore continues it
	private spent = false;
	private checkpointing = false;
	private clockOffset = 0n;
	private scratch = 0;
	private unwound: (() => void) | null = null;
	/** where the syscall router sends a call (router.ts), when the host watches file syncs */
	private route: WebAssembly.Global | null = null;
	/** files a restore still has to write back, and the task writing them */
	private pendingFiles: SyncedFile[] | null = null;
	private applying: Runner | null = null;
	/** a program opened a file with O_DSYNC, so the router hands the hook every write */
	private syncWrites = false;
	/** the kernel clock at the checkpoint this machine continues from: older files are in its image */
	private syncMark = 0n;
	/** files handed to `fileSync` since that checkpoint, which a sync reports gone if they are */
	private readonly syncedPaths = new Set<string>();
	/** statx answers by a hash of view, flags, mask and path, each with the generation it holds for */
	private fsCache: StatxTable | null = null;

	/**
	 * a machine that has not booted; `run` boots it. Its memory starts at `initialPages` 64 KiB
	 * pages
	 */
	constructor(options: MachineOptions, initialPages = 15, keep = false) {
		this.options = options;
		this.dlMisses = options.dlMisses ?? new Map();
		// the kernel's static memory, recorded at build time (scripts/wasm/memory-note.ts)
		const note = WebAssembly.Module.customSections(options.vmlinux, 'gmux.memory')[0];
		const kernelPages = note ? new DataView(note).getUint32(0, true) : 0;
		const initial = Math.max(initialPages, kernelPages);
		if (options.memory && options.memory.buffer.byteLength <= initial * 0x10000) {
			this.memory = options.memory;
			const pages = this.memory.buffer.byteLength / 0x10000;
			if (pages < initial) this.memory.grow(initial - pages);
			// Machine.resume: the memory already holds the snapshot's image
			if (!keep) new Uint8Array(this.memory.buffer).fill(0);
		} else
			this.memory = new WebAssembly.Memory({
				initial,
				maximum: options.maximumPages ?? 2048,
				shared: true
			});
		this.cpuZero = this.runner('cpu0', { kind: 'boot' });
		if (
			options.fileSync ||
			options.restoreFiles?.length ||
			options.syscallCache ||
			options.countSyscalls
		) {
			if (!options.router)
				throw new Error(
					'fileSync, restoreFiles, syscallCache and countSyscalls need MachineOptions.router'
				);
			this.route = new WebAssembly.Global(
				{ value: 'i32', mutable: true },
				options.countSyscalls ? ROUTE_HOOK : ROUTE_WATCH
			);
		}
		if (options.syscallCache) {
			// the hit path counts in the table's header
			const table = (this.fsCache = new StatxTable(options.syscallCache === 'verify'));
			Object.defineProperties(this.stats, {
				statxHits: {
					enumerable: true,
					get: () => table.hits,
					set: (count: number) => (table.hits = count)
				},
				statxMisses: {
					enumerable: true,
					get: () => table.misses,
					set: (count: number) => (table.misses = count)
				}
			});
		}
	}

	/** whether a task is ready to run, which a machine with no timer to wait on can still have */
	get runnable(): boolean {
		return this.ready.length > 0;
	}

	/** the earliest Linux timer an idle task waits for, in kernel-clock nanoseconds, or null */
	get deadline(): bigint | null {
		return this.nextDeadline();
	}

	/** the kernel clock, in nanoseconds; `deadline` is on it */
	get clockNs(): bigint {
		return this.now();
	}

	private log(line: string) {
		this.options.log?.(line);
	}

	/**
	 * the kernel's cpu clock: host wall time where it moves, plus a fixed step per scheduling decision
	 * where it stands still, as a deployed Worker's does while code runs; never goes backwards
	 */
	private clock = 0n;

	private now(): bigint {
		const host =
			(this.options.now ? this.options.now() : BigInt(Date.now()) * 1000000n) +
			this.clockOffset;
		if (host > this.clock) this.clock = host;
		return this.clock;
	}

	private runner(name: string, entry: Entry): Runner {
		this.stats.runners++;
		return {
			name,
			instance: null,
			resume: null,
			value: 0,
			idle: null,
			halted: false,
			kill: false,
			user: null,
			program: null,
			saved: null,
			id: 0,
			seq: this.seqs++,
			slot: -1,
			entry,
			started: false,
			where: null,
			unwinding: false,
			rewinding: false,
			checkpointed: false,
			fail: null,
			vfork: null,
			vforkOf: null,
			handlers: 0
		};
	}

	/** parks the current runner; the pump resumes it with a value later, or a checkpoint unwinds it */
	private park(runner: Runner, where: 'kernel' | 'user' = 'kernel'): Promise<number> {
		if (this.shared) runner.saved = this.taskGlobals.map((g) => g.value);
		if (runner.shared) runner.sharedSaved = runner.shared.globals.map((g) => g.value);
		runner.where = where;
		const parked = new Promise<number>((resolve, reject) => {
			runner.resume = resolve;
			runner.fail = reject;
			const signal = this.suspended;
			this.suspended = null;
			signal?.(runner);
		});
		return parked.then((value) => (runner.unwinding ? this.beginUnwind(runner) : value));
	}

	/** a rewound stack reached the import it parked in: stop the rewind and park it again */
	private rewound(runner: Runner): Promise<number> {
		const kernel = this.exp(runner);
		if (runner.where === 'kernel') kernel.asyncify_stop_rewind();
		if (runner.program && !evacuable(runner.program.exports))
			runner.program.exports.asyncify_stop_rewind();
		runner.rewinding = false;
		return this.park(runner, runner.where ?? 'kernel');
	}

	private bytes(start: number, end: number): Uint8Array {
		return new Uint8Array(this.memory.buffer).slice(start, end);
	}

	private cstring(ptr: number): string {
		const view = new Uint8Array(this.memory.buffer);
		let end = ptr;
		while (view[end]) end++;
		return this.decoder.decode(view.slice(ptr, end));
	}

	private calls = 0;

	private imports(owner: () => Runner): WebAssembly.Imports {
		const self = this;
		const raw: Record<string, any> = this.rawImports(owner);
		if (!this.options.trace) return { env: raw };
		const traced: Record<string, any> = { memory: raw.memory };
		for (const [name, fn] of Object.entries(raw)) {
			if (name === 'memory') continue;
			if (fn instanceof WebAssembly.Suspending) {
				traced[name] = fn;
				continue;
			}
			traced[name] = (...args: unknown[]) => {
				const n = ++self.calls;
				if (n <= 300 || n % 100000 === 0)
					self.log(`call#${n} ${name}(${args.map(String).join(',')})`);
				return fn(...args);
			};
		}
		return { env: traced };
	}

	private rawImports(owner: () => Runner): Record<string, any> {
		const self = this;
		return {
			memory: this.memory,
			wasm_serialize_tasks: new WebAssembly.Suspending((prev: number, next: number) => {
				const me = owner();
				if (me.rewinding) return self.rewound(me);
				const target = self.runners.get(next);
				if (!target) throw new Error(`serialize to unknown task ${next}`);
				self.stats.switches++;
				target.value = prev;
				self.ready.unshift(target);
				// released while it ran, or before its last turn: this switch was its last
				if (me.kill && !me.vfork && !me.vforkOf) {
					if (self.runners.get(prev) === me) {
						self.unindex(me);
						self.runners.delete(prev);
					}
					const parked = self.park(me);
					queueMicrotask(() => self.abandon(me));
					return parked;
				}
				return self.park(me);
			}),
			wasm_create_and_run_task: new WebAssembly.Suspending(
				(
					prev: number,
					next: number,
					name: number,
					binStart: number,
					binEnd: number,
					dataStart: number,
					tableStart: number
				) => {
					const me = owner();
					if (me.rewinding) return self.rewound(me);
					const task = self.runner(`${self.cstring(name)}:${next}`, {
						kind: 'fork',
						prev,
						next
					});
					if (binStart) {
						// the parent's own program, which the host already accepted at its exec
						const user = self.lookup(me, binStart, binEnd, dataStart, tableStart);
						if (!user) throw new Error(`fork of an executable the host refused`);
						task.user = user;
					}
					task.resume = () => void self.startTask(task, prev, next);
					task.id = next;
					self.runners.set(next, task);
					self.stats.switches++;
					self.ready.unshift(task);
					return self.park(me);
				}
			),
			wasm_release_task: (dead: number) => self.release(dead),
			wasm_start_cpu: (cpu: number, idle: number) => {
				const runner = self.runner(`cpu${cpu}`, { kind: 'secondary', idle });
				runner.resume = () => void self.startSecondary(runner, idle);
				runner.id = idle;
				self.runners.set(idle, runner);
				self.ready.push(runner);
			},
			wasm_stop_cpu: (cpu: number) => self.log(`stop cpu ${cpu}`),
			wasm_idle_wait: new WebAssembly.Suspending((word: number, timeout: bigint) => {
				const me = owner();
				if (me.rewinding) return self.rewound(me);
				self.stats.idles++;
				self.arm(me, word, timeout < 0n ? -1n : self.now() + timeout);
				if (me.name === `cpu${IRQ_CPU}` && self.irqWord === null) {
					self.irqWord = word;
					self.raiseConsole();
				}
				return self.park(me);
			}),
			wasm_cpu_relax: new WebAssembly.Suspending(() => {
				const me = owner();
				if (me.rewinding) return self.rewound(me);
				self.stats.relaxes++;
				me.value = 0;
				self.ready.push(me);
				return self.park(me);
			}),
			wasm_delay: () => {},
			wasm_halt: new WebAssembly.Suspending(() => {
				const me = owner();
				me.halted = true;
				self.halted = true;
				self.log(`halt from ${me.name}`);
				return new Promise<number>(() => {
					const signal = self.suspended;
					self.suspended = null;
					signal?.(me);
				});
			}),
			wasm_panic: (msg: number) => {
				const text = self.cstring(msg);
				self.log(`kernel panic: ${text}`);
				throw new Trap('panic');
			},
			wasm_dump_stacktrace: (buffer: number, max: number) => {
				const text = new TextEncoder().encode((new Error().stack ?? '').slice(0, max - 1));
				new Uint8Array(self.memory.buffer).set(text, buffer);
				new Uint8Array(self.memory.buffer)[buffer + text.length] = 0;
			},
			wasm_load_executable: (
				binStart: number,
				binEnd: number,
				dataStart: number,
				tableStart: number
			) => {
				// a refusal fails the exec (kernel patch 0018), which kills just that process
				const user = self.lookup(owner(), binStart, binEnd, dataStart, tableStart);
				if (!user) return 1;
				owner().user = user;
				return 0;
			},
			// the handler runs on a stack of its own, so a handler that blocks parks like any code
			wasm_user_mode_tail: new WebAssembly.Suspending((flow: number) => {
				const me = owner();
				if (me.rewinding && me.signal) return self.rewindSignal(me);
				if (flow === -1) throw new Trap('reload_program');
				if (!(flow & 1)) {
					if (flow & 2) throw new Trap('signal_return');
					return 0;
				}
				return self.handleSignal(me, flow);
			}),
			// the kernel hands over the time it charged since its last read (each syscall's cost), which
			// moves the clock while the host's own stands still
			wasm_cpu_clock_get_monotonic: (charged?: bigint) => {
				if (charged) self.clock = self.now() + BigInt(charged);
				return self.now();
			},
			wasm_random_get_bytes: (buffer: number, count: number) => {
				if (count > 0x10000) return -1;
				const data = new Uint8Array(count);
				crypto.getRandomValues(data);
				new Uint8Array(self.memory.buffer).set(data, buffer);
				return count;
			},
			wasm_driver_hvc_put: (buffer: number, count: number) => {
				self.options.write?.(self.decoder.decode(self.bytes(buffer, buffer + count)));
				return count;
			},
			// a fork child's own memory (kernel patch 0015); mode 0 from the user, 1 to it, 2 zeroes it
			wasm_user_copy: (kaddr: number, uaddr: number, n: number, mode: number) => {
				const mem = self.userMemory(owner());
				const [k, u, len] = [kaddr >>> 0, uaddr >>> 0, n >>> 0];
				if (mem === self.memory) return len;
				self.stats.userCopies++;
				self.stats.userCopyBytes += len;
				const domain = self.domain(mem);
				if (mode === 0) return copyIn(domain, k, u, len);
				if (mode === 1) return copyOut(domain, k, u, len);
				return clear(domain, u, len);
			},
			// a string there in one crossing: mode 0 copies it to the kernel and returns its length (or
			// -EFAULT), mode 1 returns its length with the NUL (or 0); count means no NUL within count
			wasm_user_string: (kaddr: number, uaddr: number, count: number, mode: number) => {
				const mem = self.userMemory(owner());
				if (mem === self.memory) return mode ? 0 : EFAULT;
				self.stats.userStrings++;
				const domain = self.domain(mem);
				const limit = count >>> 0;
				const len = stringLength(domain, uaddr, limit);
				if (mode === 1) return len < 0 ? 0 : len < limit ? len + 1 : (limit + 1) | 0;
				if (len < 0) return EFAULT;
				const bytes = len < limit ? len + 1 : limit;
				self.stats.userStringBytes += bytes;
				return copyIn(domain, kaddr >>> 0, uaddr >>> 0, bytes) ? EFAULT : len;
			},
			// futex atomics there: FUTEX_OP_SET, ADD, OR, ANDN, XOR, and 5 for compare-exchange
			wasm_user_atomic: (
				op: number,
				uaddr: number,
				arg: number,
				arg2: number,
				kold: number
			) => {
				const mem = self.userMemory(owner());
				const u = uaddr >>> 0;
				if (mem === self.memory || u & 3 || !self.domain(mem).span(u, 4, READ | WRITE))
					return EFAULT;
				const word = new Int32Array(mem.buffer);
				const at = u >> 2;
				const old =
					op === 0
						? Atomics.exchange(word, at, arg)
						: op === 1
							? Atomics.add(word, at, arg)
							: op === 2
								? Atomics.or(word, at, arg)
								: op === 3
									? Atomics.and(word, at, ~arg)
									: op === 4
										? Atomics.xor(word, at, arg)
										: Atomics.compareExchange(word, at, arg, arg2);
				new DataView(self.memory.buffer).setUint32(kold >>> 0, old >>> 0, true);
				return 0;
			},
			// the child gets a mapping: its bytes as the kernel's memory holds them now (at fork, the parent's)
			wasm_user_mapped: (mm: number, start: number, end: number) => {
				const [id, from, to] = [mm >>> 0, start >>> 0, end >>> 0];
				let mem = self.privateMemories.get(id);
				const pages = Math.ceil(to / 0x10000);
				if (!mem) {
					mem = new WebAssembly.Memory({
						initial: pages,
						maximum: self.options.maximumPages ?? 2048,
						shared: true
					});
					self.privateMemories.set(id, mem);
					if (self.pendingFork) self.forkChildren.set(id, self.pendingFork);
				}
				const have = mem.buffer.byteLength / 0x10000;
				if (pages > have) mem.grow(pages - have);
				// at a fork the parent's bytes, which are in its own memory when it is itself a fork child
				const source = self.pendingFork ? self.userMemory(owner()) : self.memory;
				new Uint8Array(mem.buffer).set(
					new Uint8Array(source.buffer, from, to - from),
					from
				);
			},
			// the kernel is about to read or write another process's pages (kernel patch 0021)
			wasm_user_touch: new WebAssembly.Suspending((addr: number, len: number) =>
				self.fillDeferredRange(addr >>> 0, len >>> 0)
			),
			wasm_user_forget: (mm: number) => {
				self.privateMemories.delete(mm >>> 0);
				self.forkChildren.delete(mm >>> 0);
				self.forkSpills.delete(mm >>> 0);
			},
			wasm_driver_hvc_get: (buffer: number, count: number) => {
				self.stats.consoleReads++;
				const n = Math.min(count, self.input.length);
				if (n > 0) new Uint8Array(self.memory.buffer).set(self.input.splice(0, n), buffer);
				return n;
			},
			wasm_net_listen: (port: number, on: number) => self.net.listen(port, on !== 0),
			wasm_net_next: (event: number, buf: number, cap: number) =>
				self.net.next(self.memory, event, buf, cap),
			wasm_net_send: (id: number, buf: number, n: number) =>
				self.net.send(id, new Uint8Array(self.memory.buffer, buf, n)),
			wasm_net_end: (id: number, how: number) => self.net.end(id, how)
		};
	}

	/** the module for an executable the calling task runs: its guarded build when the task is not root */
	private lookup(
		caller: Runner,
		binStart: number,
		binEnd: number,
		dataStart: number,
		tableStart: number
	) {
		const bytes = this.bytes(binStart, binEnd);
		const hash = stubHash(bytes) ?? this.options.sha256(bytes);
		let module = this.options.registry.get(hash);
		const guarded = this.options.guarded;
		if (module && guarded && Number(this.exp(caller).wasm_current_euid?.() ?? 0) !== 0) {
			module = guarded.get(hash);
			if (!module)
				this.stats.unknownExecutables.push(
					`${hash} (${bytes.length} bytes, no guarded build)`
				);
		} else if (!module) this.stats.unknownExecutables.push(`${hash} (${bytes.length} bytes)`);
		if (!module) return undefined;
		const missed = this.dlMisses.get(hash);
		if (missed?.size) {
			const interpreted = this.options.interpret?.(hash, [...missed]);
			if (interpreted) {
				this.stats.interpretedStarts.push(hash);
				module = interpreted;
			}
		}
		const needs = WebAssembly.Module.customSections(module, 'gmux.data')[0];
		const mapped = dylinkInfo(bytes)?.memorySize;
		if (needs && mapped !== undefined) {
			const size = new DataView(needs).getUint32(0, true);
			// the kernel maps the stub's size by whole pages (binfmt_wasm)
			if (size > Math.ceil(mapped / 0x1000) * 0x1000) {
				this.stats.unknownExecutables.push(
					`${hash} (needs ${size} bytes of data, stub maps ${mapped})`
				);
				return undefined;
			}
		}
		return { module, hash, dataStart, tableStart };
	}

	private release(dead: number) {
		if (this.options.trace) this.log(`release ${dead} ${this.runners.get(dead)?.name}`);
		const runner = this.runners.get(dead);
		if (!runner) return;
		if (runner === this.current) runner.kill = true;
		else {
			this.unindex(runner);
			this.runners.delete(dead);
			// one still in the ready queue has a turn to take (its final switch); it goes after that
			if (this.ready.includes(runner)) runner.kill = true;
			else this.abandon(runner);
		}
	}

	/** unwinds a released task's parked stack, so its frames and instances can be collected */
	private abandon(runner: Runner) {
		const fail = runner.fail;
		runner.resume = null;
		runner.fail = null;
		if (!fail) return;
		this.stats.abandonedStacks++;
		fail(new Abandoned());
	}

	private shared: WebAssembly.Instance | null = null;
	private taskGlobals: WebAssembly.Global[] = [];
	private initialGlobals: number[] = [];

	private instantiate(runner: Runner): WebAssembly.Instance {
		if (this.options.sharedKernel || this.options.asyncify) {
			if (!this.shared) {
				this.stats.instances++;
				this.shared = new WebAssembly.Instance(
					this.options.vmlinux,
					this.imports(() => this.current!)
				);
				this.taskGlobals = TASK_GLOBALS.map(
					(name) => this.shared!.exports[name] as WebAssembly.Global
				);
				this.initialGlobals = this.taskGlobals.map((g) => g.value);
			}
			// a new task starts from the globals a fresh instance would have
			this.taskGlobals.forEach((g, i) => (g.value = this.initialGlobals[i]));
			runner.instance = this.shared;
			return this.shared;
		}
		this.stats.instances++;
		const instance = new WebAssembly.Instance(
			this.options.vmlinux,
			this.imports(() => runner)
		);
		runner.instance = instance;
		return instance;
	}

	private exp(runner: Runner) {
		return runner.instance!.exports as Record<string, any>;
	}

	private finished(runner: Runner, error?: unknown) {
		// an abandoned stack was not running: the pump waits on another task
		if (error instanceof Abandoned) return;
		if (error && !(error instanceof Trap && error.kind === 'panic')) {
			this.crashed = error;
			this.log(`${runner.name} crashed: ${String((error as Error)?.stack ?? error)}`);
		}
		const signal = this.suspended;
		this.suspended = null;
		signal?.(runner);
	}

	private async boot() {
		const runner = this.cpuZero;
		const exports = this.exp(runner);
		runner.id = Number(exports.init_task.value);
		runner.started = true;
		this.runners.set(runner.id, runner);
		const encoded = new TextEncoder().encode(`${this.options.cmdline}\0`);
		new Uint8Array(this.memory.buffer).set(encoded, Number(exports.boot_command_line.value));
		const pages = Math.ceil(this.options.initrd.byteLength / 0x10000);
		const start = this.memory.grow(pages) * 0x10000;
		new Uint8Array(this.memory.buffer).set(this.options.initrd, start);
		const view = new DataView(this.memory.buffer);
		view.setUint32(Number(exports.initrd_start.value), start, true);
		view.setUint32(
			Number(exports.initrd_end.value),
			start + this.options.initrd.byteLength,
			true
		);
		// before _start: the kernel grows its RAM to the memory maximum and leaves no room after it
		if (this.options.asyncify) this.ensureScratch();
		if (this.options.core)
			this.startCore(this.memory.grow(coreRegionPages(this.options.core)) * 0x10000);
		await this.enter(runner, () => WebAssembly.promising(exports._start)(), '_start');
	}

	/** calls a kernel entry; a stack that unwinds for a checkpoint comes back here and stops */
	private async enter(runner: Runner, call: () => Promise<unknown>, name: string) {
		try {
			await call();
			if (runner.unwinding || runner.checkpointed) return this.endUnwind(runner);
			this.finished(runner, new Error(`${name} returned`));
		} catch (error) {
			this.finished(runner, error);
		}
	}

	private async startSecondary(runner: Runner, idle: number, restoring = false) {
		if (!restoring) this.instantiate(runner);
		runner.started = true;
		await this.enter(
			runner,
			() => WebAssembly.promising(this.exp(runner)._start_secondary)(idle),
			'start_secondary'
		);
	}

	private async startTask(runner: Runner, prev: number, next: number, restoring = false) {
		if (!restoring) this.instantiate(runner);
		runner.started = true;
		try {
			const clone = await WebAssembly.promising(this.exp(runner).ret_from_fork)(prev, next);
			if (runner.unwinding || runner.checkpointed) return this.endUnwind(runner);
			if (clone && this.adoptForkChild(runner)) return await this.forkChildStarts(runner);
			if (clone && this.adoptVforkChild(runner)) return this.vforkChildStarts(runner);
			await this.userChain(runner, !!clone);
		} catch (error) {
			this.finished(runner, error);
		}
	}

	/** a fresh instance of the task's user program over the shared memory */
	private program(
		runner: Runner,
		stackPointer: number
	): { ux: Record<string, any>; global: WebAssembly.Global; dl?: DlView } {
		const user = runner.user!;
		if (
			this.options.shareInstances &&
			this.shared &&
			shareable(user.module) &&
			this.userMemory(runner) === this.memory
		)
			return this.sharedProgram(runner, stackPointer);
		runner.shared = null;
		const global = new WebAssembly.Global({ value: 'i32', mutable: true }, stackPointer);
		const base = (value: number, mutable = false) =>
			new WebAssembly.Global({ value: 'i32', mutable }, value);
		// a shareable program imports its memory base mutable, and runs alone just as well
		const memoryBase = base(user.dataStart, shareable(user.module));
		const env = this.userEnv(runner, global, memoryBase, base(user.tableStart));
		const loader = this.dlProcess(user.dataStart);
		loader.exe = { hash: user.hash };
		const dl = loader.view();
		Object.assign(env, dl.imports());
		const instance = this.instantiateUser(runner, env);
		dl.attach({
			exports: instance.exports as Record<string, any>,
			table: env.__indirect_function_table as WebAssembly.Table,
			stackPointer: global,
			env
		});
		return { ux: instance.exports as Record<string, any>, global, dl };
	}

	/**
	 * the process runs on its program's one instance. The first process instantiates it; a later
	 * one gets its own bases, stack pointer, fresh globals and GOT, and TLS at its own data start (its
	 * data image comes from the template in enterProgram)
	 */
	private sharedProgram(
		runner: Runner,
		stackPointer: number
	): { ux: Record<string, any>; global: WebAssembly.Global } {
		const user = runner.user!;
		let s = this.sharedPrograms.get(user.hash);
		if (!s) {
			const g = (value: number) =>
				new WebAssembly.Global({ value: 'i32', mutable: true }, value);
			const [memoryBase, stack] = [g(user.dataStart), g(stackPointer)];
			const tableBase = new WebAssembly.Global(
				{ value: 'i32', mutable: false },
				user.tableStart
			);
			const exports = this.instantiateUser(
				runner,
				this.userEnv(runner, stack, memoryBase, tableBase)
			).exports as Record<string, any>;
			const own = Object.keys(exports)
				.filter((k) => /^gmux_g\d+$/.test(k))
				.map((k) => exports[k] as WebAssembly.Global);
			s = {
				exports,
				memoryBase,
				stackPointer: stack,
				globals: [memoryBase, stack, ...own],
				initial: own.map((x) => Number(x.value)),
				tlsOffset: (exports.__get_tls_base?.() ?? user.dataStart) - user.dataStart,
				template: null,
				tableStart: user.tableStart
			};
			this.sharedPrograms.set(user.hash, s);
		} else {
			if (user.tableStart !== s.tableStart)
				throw new Error(
					`shared program ${user.hash}: table base ${user.tableStart}, not ${s.tableStart}`
				);
			s.memoryBase.value = user.dataStart;
			s.stackPointer.value = stackPointer;
			s.globals.slice(2).forEach((x, i) => (x.value = s!.initial[i]!));
			this.hostCalling = true;
			try {
				s.exports.__wasm_apply_global_relocs();
				s.exports.__set_tls_base?.(user.dataStart + s.tlsOffset);
			} finally {
				this.hostCalling = false;
			}
			this.stats.sharedEntries++;
		}
		runner.shared = s;
		runner.sharedSaved = null;
		return { ux: s.exports, global: s.stackPointer };
	}

	private instantiateUser(runner: Runner, env: Record<string, unknown>): WebAssembly.Instance {
		const user = runner.user!;
		const imports: WebAssembly.Imports = { env: env as WebAssembly.ModuleImports };
		if (
			WebAssembly.Module.imports(user.module).some(
				(i) => i.module === 'gmux' && i.name === 'tlb'
			)
		) {
			// 4 bytes of page table for each 4 KiB page the machine's memory can grow to
			const pages = (this.options.maximumPages ?? 2048) * 16;
			const tlb = new WebAssembly.Memory({ initial: Math.ceil((pages * 4) / 0x10000) });
			imports.gmux = { tlb };
			env.__gmux_mmu_miss = (address: number) => this.mmuMiss(tlb, address);
			env.__gmux_mmu_fault = new WebAssembly.Suspending((address: number) =>
				this.mmuFault(tlb, address)
			);
		}
		if (
			WebAssembly.Module.imports(user.module).some(
				(i) => i.module === 'gmux' && i.name === 'table'
			)
		) {
			// scripts/wasm/guard-pass.ts: loads and stores checked against the kernel's page owner
			// table and the process's set of shared regions
			const kernel = this.exp(runner);
			const fixed = (value: number) =>
				new WebAssembly.Global({ value: 'i32', mutable: false }, value);
			imports.gmux = {
				...imports.gmux,
				table: fixed(Number(kernel.wasm_owner_table())),
				tag: fixed(Number(kernel.wasm_current_owner())),
				set: fixed(Number(kernel.wasm_current_set?.() ?? 0))
			};
			env.__gmux_denied = (address: number) => {
				throw new WebAssembly.RuntimeError(`memory access denied at ${address >>> 0}`);
			};
		}
		this.hostCalling = true;
		let instance: WebAssembly.Instance;
		try {
			instance = new WebAssembly.Instance(user.module, imports);
		} finally {
			this.hostCalling = false;
		}
		this.stats.userExecs++;
		if (this.options.trace)
			this.log(`program for ${runner.name} data=${user.dataStart} table=${user.tableStart}`);
		return instance;
	}

	/** the imports a user program instance gets */
	private userEnv(
		runner: Runner,
		global: WebAssembly.Global,
		memoryBase: WebAssembly.Global,
		tableBase: WebAssembly.Global
	): Record<string, unknown> {
		const user = runner.user!;
		const kernel = this.exp(runner);
		const env: Record<string, unknown> = {
			memory: this.userMemory(runner),
			__memory_base: memoryBase,
			__stack_pointer: global,
			__indirect_function_table: new WebAssembly.Table({
				initial: user.tableStart + tableEntries(user.module),
				element: 'anyfunc'
			}),
			__table_base: tableBase,
			__table_base32: tableBase,
			__wasm_abort: () => {
				throw new WebAssembly.RuntimeError('abort');
			},
			// scripts/wasm/stack-pass.ts: a frame allocation left its stack segment
			__gmux_stack_move: (sp: number) =>
				this.stackMove(this.shared ? this.current! : runner, sp),
			// fuel ran out in a user loop: give the other cpus the host thread, then refill
			__gmux_fuel: new WebAssembly.Suspending(() => {
				// a vfork child runs this instance as another task
				const me = this.shared ? this.current! : runner;
				if (me.rewinding) return this.rewound(me);
				if (me.reentered !== undefined) {
					const value = me.reentered;
					me.reentered = undefined;
					return value;
				}
				this.stats.fuelYields++;
				me.value = this.options.fuelBudget ?? 200000;
				this.ready.push(me);
				return this.park(me, 'user')
					.then((value) => this.userInterrupt(me, value))
					.then((value) => this.reenter(me, value));
			}),
			__gmux_vfork: new WebAssembly.Suspending((env: number) => this.vforkStart(env)),
			// musl's _Fork (musl patch 0008)
			__gmux_fork: () => this.fork(this.shared ? this.current! : runner),
			__gmux_vfork_exec: new WebAssembly.Suspending(
				(path: number, argv: number, envp: number) =>
					this.vforkTerminal(SYS_EXECVE, [path, argv, envp])
			),
			__gmux_vfork_exit: new WebAssembly.Suspending((status: number) =>
				this.vforkTerminal(SYS_EXIT_GROUP, [status])
			)
		};
		if (!this.route) {
			for (let n = 0; n <= 6; n++) env[`__wasm_syscall_${n}`] = kernel[`wasm_syscall_${n}`];
			return env;
		}
		const k: Record<string, unknown> = {};
		const h: Record<string, unknown> = {};
		for (let n = 0; n <= 6; n++) {
			// a kernel without an arity (the unit tests' toy one) never gets a call at it
			k[n] =
				kernel[`wasm_syscall_${n}`] ??
				(() => {
					throw new Error(`the kernel has no wasm_syscall_${n}`);
				});
			h[n] = new WebAssembly.Suspending(
				(sp: number, tls: number, nr: number, ...args: number[]) =>
					this.syscallHook(this.shared ? this.current! : runner, sp, tls, nr, args)
			);
		}
		const modules = this.options.router!;
		// the hit path reads the task's memory and the table, and asks the kernel for the view and
		// the generation
		const hit = this.fsCache
			? new WebAssembly.Instance(modules.statx, {
					env: { user: env.memory as WebAssembly.Memory, table: this.fsCache.memory },
					kernel: {
						view: kernel.wasm_fs_view as WebAssembly.ImportValue,
						gen: kernel.wasm_fs_gen as WebAssembly.ImportValue,
						// a kernel without patch 0029 has no counters: statxFill then keeps no fine answers
						at: (kernel.wasm_fs_gen_at ?? (() => 0)) as WebAssembly.ImportValue
					}
				}).exports.hit
			: () => MISS;
		const router = new WebAssembly.Instance(modules.route, {
			k: k as WebAssembly.ModuleImports,
			h: h as WebAssembly.ModuleImports,
			c: { 5: hit as WebAssembly.ImportValue },
			env: {
				memory: env.memory as WebAssembly.Memory,
				route: this.route!,
				cache: new WebAssembly.Global({ value: 'i32', mutable: true }, this.fsCache ? 1 : 0)
			}
		}).exports;
		for (let n = 0; n <= 6; n++) env[`__wasm_syscall_${n}`] = router[`s${n}`];
		return env;
	}

	private idleRoute(): number {
		return this.options.countSyscalls
			? ROUTE_HOOK
			: this.syncWrites
				? ROUTE_WRITES
				: ROUTE_WATCH;
	}

	private reportCall(me: Runner, nr: number, args: number[], ret: number | null) {
		const report = this.options.countSyscalls;
		if (typeof report !== 'function') return;
		const mem = () => new Uint8Array(this.userMemory(me).buffer);
		report({
			task: me.id,
			nr,
			args,
			ret,
			string: (address) => {
				const bytes = mem();
				const at = address >>> 0;
				return String.fromCharCode(...bytes.subarray(at, bytes.indexOf(0, at)));
			}
		});
	}

	/**
	 * the router's hook: a restore's files go back in first, then an fsync or fdatasync of a regular
	 * file hands the file to `fileSync` before the kernel's own sync runs, and the call returns after
	 * both. Its kernel calls are the task's own, as userInterrupt's are
	 */
	private async syscallHook(
		me: Runner,
		sp: number,
		tls: number,
		nr: number,
		args: number[]
	): Promise<number> {
		const kernel = this.exp(me);
		me.syncing = true;
		try {
			// one task writes a restore's files back; any other waits its turn in the ready queue
			while (this.pendingFiles || (this.applying && this.applying !== me)) {
				if (this.pendingFiles && !this.applying) {
					this.applying = me;
					try {
						await this.applyFiles(me, sp, tls, this.pendingFiles);
					} finally {
						this.pendingFiles = null;
						this.applying = null;
						this.route!.value = this.idleRoute();
					}
					break;
				}
				this.ready.push(me);
				await this.park(me, 'user');
			}
			// -1 without fileSync: every call goes straight on
			const sync = this.options.fileSync ? nr : -1;
			if (sync === SYS_FSYNC || sync === SYS_FDATASYNC || sync === SYS_SYNC_FILE_RANGE)
				await this.syncFile(me, sp, tls, args[0]!);
			else if (sync === SYS_MSYNC && args[2]! & MS_SYNC)
				await this.syncMapped(me, sp, tls, args[0]! >>> 0, args[1]! >>> 0);
			else if (sync === SYS_SYNC) await this.syncAll(me, sp, tls);
			else if (sync === SYS_SYNCFS) await this.syncAll(me, sp, tls, args[0]!);
			const query = this.fsCache && nr === SYS_STATX ? this.statxQuery(me, args) : null;
			// execve and the exits may never return
			const noReturn = nr === 221 || nr === 93 || nr === 94;
			if (this.options.countSyscalls) {
				this.stats.syscalls[nr] = (this.stats.syscalls[nr] ?? 0) + 1;
				if (noReturn) this.reportCall(me, nr, args, null);
			}
			const result =
				Number(
					await WebAssembly.promising(kernel[`wasm_syscall_${args.length}`])(
						sp,
						tls,
						nr,
						...args
					)
				) | 0;
			if (query) await this.statxFill(me, sp, tls, query, result, args[4]! >>> 0);
			if (this.options.countSyscalls) this.reportCall(me, nr, args, result);
			if (result < 0) return result;
			if (sync === SYS_OPENAT && args[2]! & O_DSYNC) {
				// ponytail: once set, every write on the machine passes the hook; a per-fd table in
				// the kernel would narrow it to the synchronous files
				this.syncWrites = true;
				this.route!.value = ROUTE_WRITES;
			} else if (WRITE_CALLS.includes(sync) || sync === SYS_PWRITEV2) {
				// a synchronous write returns once its file is durable, as fsync after it would
				const fd =
					sync === SYS_SPLICE || sync === SYS_COPY_FILE_RANGE ? args[2]! : args[0]!;
				const flags =
					sync === SYS_PWRITEV2 && args[5]! & (RWF_DSYNC | RWF_SYNC)
						? O_DSYNC
						: await this.sys(me, sp, tls, SYS_FCNTL, fd, F_GETFL);
				if (flags >= 0 && flags & O_DSYNC) await this.syncFile(me, sp, tls, fd);
			}
			return result;
		} finally {
			me.syncing = false;
		}
	}

	/**
	 * the cache key of a statx at `args` (dirfd, path, flags, mask, buf) and the generation it is asked
	 * at, or null when its answer may depend on more than the path: a relative path (the cwd, the
	 * dirfd), or a task that could be refused a directory or sees other mounts (kernel patch 0022)
	 */
	private statxQuery(me: Runner, args: number[]) {
		const kernel = this.exp(me);
		const view = Number(kernel.wasm_fs_view?.() ?? 0) >>> 0;
		if (!view) return null;
		const mem = new Uint8Array(this.userMemory(me).buffer);
		const at = args[1]! >>> 0;
		const hash = statxHash(mem, at, view, args[2]!, args[3]!);
		if (hash === null) return null;
		const path = mem.slice(at, mem.indexOf(0, at));
		return {
			hash,
			path,
			// one char per byte, for the ancestor walk
			name: String.fromCharCode(...path),
			view,
			flags: args[2]!,
			mask: args[3]!,
			gen: Number(kernel.wasm_fs_gen()) >>> 0
		};
	}

	/** each view's "/": its mount id and inode number */
	private readonly rootInfo = new Map<number, { mount: number; ino: number; mode: number }>();

	/**
	 * keeps the kernel's answer to a statx when nothing changed while it was asked and the lookup
	 * ended on the root mount (a proc or sysfs answer changes with no timestamp moving). Only answers
	 * that follow from the path are kept: success, ENOENT and ENOTDIR, never EFAULT. A kernel with
	 * patch 0029 holds an answer on the counters of the inodes its path crossed, so a change anywhere
	 * else leaves it; any other answer holds on the kernel's whole generation
	 */
	private async statxFill(
		me: Runner,
		sp: number,
		tls: number,
		q: NonNullable<ReturnType<Machine['statxQuery']>>,
		result: number,
		buf: number
	) {
		const kernel = this.exp(me);
		const gen = () => Number(kernel.wasm_fs_gen()) >>> 0;
		const at: ((index: number) => number) | undefined = kernel.wasm_fs_gen_at;
		if ((result !== 0 && result !== -2 && result !== -20) || gen() !== q.gen) return;
		const bytes =
			result === 0 ? new Uint8Array(this.userMemory(me).buffer).slice(buf, buf + 256) : null;
		// a device, fifo or socket's times move without the generation (kernel patch 0022)
		const type = bytes ? new DataView(bytes.buffer).getUint16(28, true) & S_IFMT : 0;
		if (bytes && !(bytes[0]! & 1 && [0o100000, S_IFDIR, S_IFLNK].includes(type))) return;
		const held = this.fsCache!.get(q.hash);
		if (
			held &&
			(held.guards?.length
				? Number(at!(-1)) >>> 0 === held.gen &&
					held.guards.every(([index, value]) => Number(at!(index)) >>> 0 === value)
				: held.gen === q.gen) &&
			held.view === q.view &&
			held.flags === q.flags &&
			held.mask === q.mask &&
			held.path.length === q.path.length &&
			held.path.every((b, i) => b === q.path[i]) &&
			(held.ret !== result || (bytes && !bytes.every((b, i) => b === held.bytes?.[i])))
		)
			this.stats.statxMismatches++;
		// a task's "/" is its root dentry, the view, whatever is mounted over it later
		let root = this.rootInfo.get(q.view);
		if (!root) {
			const probe = await this.statxProbe(me, sp, tls, '/', 0);
			if (!probe) return;
			this.rootInfo.set(q.view, (root = probe));
		}
		const inos = at ? await this.statxChain(me, sp, tls, q, result, root) : null;
		if (!inos) {
			let mount: number | null | undefined =
				bytes && new DataView(bytes.buffer).getUint32(0, true) & STATX_MNT_ID
					? Number(new DataView(bytes.buffer).getBigUint64(144, true))
					: undefined;
			if (bytes && mount === undefined) {
				const probe = await this.statxProbe(me, sp, tls, q.name, q.flags);
				mount = probe ? probe.mount : probe;
			}
			// a missing path: the nearest ancestor that exists holds the lookup's last mount
			for (let p = q.name; mount === undefined && p !== '/';) {
				p = p.slice(0, p.lastIndexOf('/')) || '/';
				const probe = await this.statxProbe(me, sp, tls, p, 0);
				mount = probe ? probe.mount : probe;
			}
			if (mount !== root.mount) return;
		}
		// the counters are read with nothing awaited between them and the generation check
		const guards = inos
			? [...new Set(inos.map(statxBucket))].map((b): [number, number] => [
					b,
					Number(at!(b)) >>> 0
				])
			: undefined;
		const stamp = inos ? Number(at!(-1)) >>> 0 : q.gen;
		if (gen() !== q.gen) return;
		const { view, flags, mask, path } = q;
		if (
			this.fsCache!.set(q.hash, {
				view,
				flags,
				mask,
				path,
				gen: stamp,
				guards,
				ret: result,
				bytes
			})
		) {
			this.stats.statxFills++;
			if (inos) this.stats.statxFineFills++;
		}
	}

	/**
	 * the inode numbers of the root and of every prefix of the lookup's path, when an answer about it
	 * depends on nothing else: no `.` or `..`, no symlink to follow, every prefix on the root mount
	 * and few enough to guard. A missing path ends at the last prefix that exists, a file with more
	 * path after it at that file. Null otherwise
	 */
	private async statxChain(
		me: Runner,
		sp: number,
		tls: number,
		q: NonNullable<ReturnType<Machine['statxQuery']>>,
		result: number,
		root: { mount: number; ino: number }
	) {
		const parts = q.name.split('/').filter(Boolean);
		if (parts.some((part) => part === '.' || part === '..') || parts.length >= STATX_GUARDS)
			return null;
		const inos = [root.ino];
		for (let i = 1; i <= parts.length; i++) {
			const path = `/${parts.slice(0, i).join('/')}`;
			const probe = await this.statxProbe(me, sp, tls, path, AT_SYMLINK_NOFOLLOW);
			if (probe === undefined) return result === -2 ? inos : null;
			if (probe === null || probe.mount !== root.mount) return null;
			inos.push(probe.ino);
			const kind = probe.mode & S_IFMT;
			const last = i === parts.length;
			if (
				kind === S_IFLNK &&
				!(last && q.flags & AT_SYMLINK_NOFOLLOW && !q.name.endsWith('/'))
			)
				return null;
			if (kind !== S_IFDIR && !last) return result === -20 ? inos : null;
		}
		return result === -2 ? null : inos;
	}

	/**
	 * mount id, inode number and mode of `path` by a statx the hook makes below the task's stack
	 * pointer; undefined when the path does not resolve, null when the answer cannot be had
	 */
	private async statxProbe(me: Runner, sp: number, tls: number, path: string, flags: number) {
		this.stats.statxProbes++;
		const at = (sp - 8192) & ~15;
		const low = Number(this.exp(me).wasm_user_stack_low?.(sp) ?? 0) >>> 0;
		if (at < low) return null;
		const mem = new Uint8Array(this.userMemory(me).buffer);
		for (let i = 0; i < path.length; i++) mem[at + i] = path.charCodeAt(i);
		mem[at + path.length] = 0;
		const statx = at + 4608;
		// the region is free stack; a signal frame the call might push goes below it
		const mask = STATX_MNT_ID | STATX_INO | STATX_TYPE;
		const r = await this.sys(me, at, tls, SYS_STATX, AT_FDCWD, at, flags, mask, statx);
		if (r === -2 || r === -20) return undefined;
		const view = new DataView(this.userMemory(me).buffer);
		if (r < 0 || (view.getUint32(statx, true) & mask) !== mask) return null;
		return {
			mount: Number(view.getBigUint64(statx + 144, true)),
			ino: view.getUint32(statx + 32, true),
			mode: view.getUint16(statx + 28, true)
		};
	}

	/** a synchronous-looking kernel call in the task's context, which may park it */
	private async sys(me: Runner, sp: number, tls: number, nr: number, ...args: number[]) {
		const call = this.exp(me)[`wasm_syscall_${args.length}`];
		return Number(await WebAssembly.promising(call)(sp, tls, nr, ...args)) | 0;
	}

	/**
	 * the hook's view of the task's scratch mapping: a path at 0, statx at 4608, reads from 8192.
	 * Null when the task has no mapping to lend
	 */
	private hookScratch(me: Runner, sp: number, tls: number) {
		const scratch = this.forkSpill(me);
		if (!scratch) return null;
		const mem = () => new Uint8Array(this.userMemory(me).buffer);
		const buffer = scratch + 8192;
		const chunk = FORK_SPILL - 8192;
		const put = (s: string) => mem().set(new TextEncoder().encode(`${s}\0`), scratch);
		const sys = (nr: number, ...args: number[]) => this.sys(me, sp, tls, nr, ...args);
		return {
			scratch,
			put,
			sys,
			/** statx of a path, or of fd `at` itself when `path` is empty */
			stat: async (path: string, flags = 0, at = AT_FDCWD) => {
				put(path);
				const statx = scratch + 4608;
				if ((await sys(SYS_STATX, at, scratch, flags, 0x7ff, statx)) < 0) return null;
				const view = new DataView(this.userMemory(me).buffer);
				return {
					mode: view.getUint16(statx + 28, true),
					size: Number(view.getBigUint64(statx + 40, true)),
					ctime:
						view.getBigInt64(statx + 96, true) * 1_000_000_000n +
						BigInt(view.getUint32(statx + 104, true)),
					dev: `${view.getUint32(statx + 136, true)}:${view.getUint32(statx + 140, true)}`
				};
			},
			/** a file's whole contents, read through a descriptor of its own */
			read: async (path: string, size = 0) => {
				put(path);
				const fd = await sys(SYS_OPENAT, AT_FDCWD, scratch, O_RDONLY | O_CLOEXEC, 0);
				if (fd < 0) return null;
				let bytes = new Uint8Array(size);
				let at = 0;
				for (;;) {
					const got = await sys(SYS_READ, fd, buffer, chunk);
					if (got <= 0) break;
					if (at + got > bytes.length) {
						const grown = new Uint8Array(Math.max(bytes.length * 2, at + got));
						grown.set(bytes);
						bytes = grown;
					}
					bytes.set(mem().subarray(buffer, buffer + got), at);
					at += got;
				}
				await sys(SYS_CLOSE, fd);
				return bytes.slice(0, at);
			},
			/** a directory's entries as [name, d_type] */
			list: async (path: string) => {
				put(path);
				const fd = await sys(
					SYS_OPENAT,
					AT_FDCWD,
					scratch,
					O_RDONLY | O_DIRECTORY | O_CLOEXEC,
					0
				);
				if (fd < 0) return [];
				const out: [string, number][] = [];
				for (;;) {
					const got = await sys(SYS_GETDENTS64, fd, buffer, 65536);
					if (got <= 0) break;
					const bytes = mem();
					const view = new DataView(bytes.buffer);
					// linux_dirent64: ino, off, reclen at 16, type at 18, name at 19
					for (let at = buffer; at < buffer + got;) {
						const length = view.getUint16(at + 16, true);
						const end = bytes.indexOf(0, at + 19);
						out.push([this.decoder.decode(bytes.slice(at + 19, end)), bytes[at + 18]!]);
						at += length || got;
					}
				}
				await sys(SYS_CLOSE, fd);
				return out;
			}
		};
	}

	/** reads the file behind `fd` through the kernel and hands it to `fileSync` */
	private async syncFile(me: Runner, sp: number, tls: number, fd: number) {
		const s = this.hookScratch(me, sp, tls);
		if (!s) return void this.stats.fileSyncsSkipped++;
		// /proc/self/fd/N names the open file; reopening it reads without moving the program's offset
		const link = `/proc/self/fd/${fd}`;
		s.put(link);
		const n = await s.sys(SYS_READLINKAT, AT_FDCWD, s.scratch, s.scratch + 256, 3840);
		const bytes = new Uint8Array(this.userMemory(me).buffer);
		const path =
			n > 0 ? this.decoder.decode(bytes.slice(s.scratch + 256, s.scratch + 256 + n)) : '';
		if (!path.startsWith('/') || path.endsWith(' (deleted)'))
			return void this.stats.fileSyncsSkipped++;
		await this.flushPath(s, link, path);
	}

	/** hands the regular file at `open` to `fileSync` under the name `path` */
	private async flushPath(
		s: NonNullable<ReturnType<Machine['hookScratch']>>,
		open: string,
		path: string
	) {
		const st = await s.stat(open);
		if (!st || (st.mode & 0o170000) !== 0o100000) return void this.stats.fileSyncsSkipped++;
		const bytes = await s.read(open, st.size);
		if (!bytes) return void this.stats.fileSyncsSkipped++;
		this.stats.fileSyncs++;
		this.stats.fileSyncBytes += bytes.byteLength;
		this.syncedPaths.add(path);
		await this.options.fileSync!({ path, mode: st.mode & 0o7777, bytes });
	}

	/** msync(MS_SYNC): every file mapped over [addr, addr + length), by /proc/self/maps */
	private async syncMapped(me: Runner, sp: number, tls: number, addr: number, length: number) {
		const s = this.hookScratch(me, sp, tls);
		if (!s) return void this.stats.fileSyncsSkipped++;
		const maps = await s.read('/proc/self/maps');
		const paths = new Set<string>();
		for (const line of this.decoder.decode(maps ?? new Uint8Array(0)).split('\n')) {
			const m = /^([0-9a-f]+)-([0-9a-f]+) \S+ \S+ \S+ \S+\s+(\/.*)$/.exec(line);
			if (!m || m[3]!.endsWith(' (deleted)')) continue;
			if (parseInt(m[1]!, 16) < addr + Math.max(length, 1) && parseInt(m[2]!, 16) > addr)
				paths.add(m[3]!);
		}
		for (const path of paths) await this.flushPath(s, path, path);
	}

	/**
	 * sync and syncfs: every regular file on the root filesystem changed since the checkpoint this
	 * machine continues from, then every file synced since then that is gone, as removed. A walk and
	 * not a checkpoint: a checkpoint needs every task parked in the kernel, and this one is in the
	 * hook until the call returns. syncfs of another filesystem (proc, devtmpfs) has nothing to keep
	 */
	private async syncAll(me: Runner, sp: number, tls: number, fd?: number) {
		const s = this.hookScratch(me, sp, tls);
		if (!s) return void this.stats.fileSyncsSkipped++;
		const root = await s.stat('/');
		if (!root) return;
		if (fd !== undefined && (await s.stat('', AT_EMPTY_PATH, fd))?.dev !== root.dev) return;
		this.stats.syncWalks++;
		// file times come from the kernel's coarse clock, a tick behind; two seconds covers it
		const since = this.syncMark - 2_000_000_000n;
		const seen = new Set<string>();
		const dirs = ['/'];
		while (dirs.length) {
			const dir = dirs.pop()!;
			for (const [name, type] of await s.list(dir)) {
				if (name === '.' || name === '..' || (type !== DT_DIR && type !== DT_REG)) continue;
				const path = `${dir === '/' ? '' : dir}/${name}`;
				const st = await s.stat(path, AT_SYMLINK_NOFOLLOW);
				if (!st || st.dev !== root.dev) continue;
				if (type === DT_DIR) dirs.push(path);
				else {
					seen.add(path);
					if (st.ctime >= since) await this.flushPath(s, path, path);
				}
			}
		}
		for (const path of [...this.syncedPaths]) {
			if (seen.has(path)) continue;
			this.syncedPaths.delete(path);
			this.stats.fileRemovals++;
			await this.options.fileSync!({
				path,
				mode: 0,
				bytes: new Uint8Array(0),
				removed: true
			});
		}
	}

	/** writes a restore's files back through the kernel, making any directory they need */
	private async applyFiles(me: Runner, sp: number, tls: number, files: SyncedFile[]) {
		const scratch = this.forkSpill(me);
		if (!scratch) {
			this.stats.fileRestoreErrors.push('no scratch mapping');
			return;
		}
		const mem = () => new Uint8Array(this.userMemory(me).buffer);
		const put = (s: string) => mem().set(new TextEncoder().encode(`${s}\0`), scratch);
		const buffer = scratch + 4096;
		const chunk = FORK_SPILL - 4096;
		for (const file of files) {
			if (file.removed) {
				put(file.path);
				const gone = await this.sys(me, sp, tls, SYS_UNLINKAT, AT_FDCWD, scratch, 0);
				// ENOENT: the checkpoint never had it
				if (gone < 0 && gone !== -2)
					this.stats.fileRestoreErrors.push(`${file.path}: ${gone}`);
				else this.stats.filesRestored++;
				continue;
			}
			const parts = file.path.split('/').filter(Boolean);
			for (let i = 1; i < parts.length; i++) {
				put(`/${parts.slice(0, i).join('/')}`);
				await this.sys(me, sp, tls, SYS_MKDIRAT, AT_FDCWD, scratch, 0o755);
			}
			put(file.path);
			const fd = await this.sys(
				me,
				sp,
				tls,
				SYS_OPENAT,
				AT_FDCWD,
				scratch,
				O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC,
				file.mode
			);
			if (fd < 0) {
				this.stats.fileRestoreErrors.push(`${file.path}: ${fd}`);
				continue;
			}
			let failed = 0;
			for (let at = 0; at < file.bytes.length && !failed;) {
				const part = file.bytes.subarray(at, at + chunk);
				mem().set(part, buffer);
				const wrote = await this.sys(me, sp, tls, SYS_WRITE, fd, buffer, part.length);
				if (wrote <= 0) failed = wrote || -5;
				else at += wrote;
			}
			await this.sys(me, sp, tls, SYS_CLOSE, fd);
			if (failed) this.stats.fileRestoreErrors.push(`${file.path}: ${failed}`);
			else this.stats.filesRestored++;
		}
	}

	/**
	 * runs the task's user program; `exec` traps back here with a new program loaded. With `restoring`,
	 * the first program is the one `Machine.restore()` already rebuilt and set rewinding
	 */
	private async userChain(runner: Runner, clone: boolean, restoring = false) {
		for (;;) {
			if (!runner.user)
				throw new Error(`${runner.name} returned to userland with no executable`);
			let ux: Record<string, any>;
			if (restoring) {
				ux = runner.program!.exports;
			} else if (runner.program?.early) {
				runner.program.early = false;
				ux = runner.program.exports;
			} else {
				ux = this.enterProgram(runner, clone).exports;
			}
			const entry = runner.program!.entry;
			const name = entry === 'clone' ? '__libc_clone_callback' : '_start';
			// a restored evacuable program rebuilds its frames from the entry's resume variant
			const start = restoring && evacuable(ux) ? ux[`${name}$resume`] : ux[name];
			restoring = false;
			clone = false;
			try {
				await WebAssembly.promising(start)();
				if (runner.unwinding || runner.checkpointed) return this.endUnwind(runner);
				throw new Error(`${entry} returned`);
			} catch (error) {
				if (
					runner.unwinding &&
					evacuable(ux) &&
					error instanceof WebAssembly.Exception &&
					(error as { is(tag: unknown): boolean }).is(ux.gmux_ckpt)
				)
					return this.endUnwind(runner);
				// a fork's frames have spilled: fork the task, then resume them here as the parent
				if (
					runner.forking &&
					evacuable(ux) &&
					error instanceof WebAssembly.Exception &&
					(error as { is(tag: unknown): boolean }).is(ux.gmux_ckpt)
				) {
					await this.forkUnwound(runner);
					restoring = true;
					continue;
				}
				if (
					runner.reentering &&
					evacuable(ux) &&
					error instanceof WebAssembly.Exception &&
					(error as { is(tag: unknown): boolean }).is(ux.gmux_ckpt)
				) {
					runner.reentering = false;
					ux.gmux_unwinding.value = 0;
					runner.program!.stackPointer.value = runner.reenterSp!;
					this.stats.reentries++;
					restoring = true;
					continue;
				}
				if (error instanceof Trap && error.kind === 'reload_program') continue;
				if (isFault(error)) return this.fault(runner, error as Error);
				throw error;
			}
		}
	}

	/**
	 * a task resuming from a user-mode yield takes its cpu's due timer and raised interrupts
	 * (wasm_user_interrupt), then passes through the kernel when a signal or a reschedule waits, as it
	 * would returning from a timer interrupt; otherwise a busy loop never sees either
	 */
	private async userInterrupt(me: Runner, value: number): Promise<number> {
		const kernel = this.exp(me);
		if (me.unwinding || me.rewinding) return value;
		me.interrupting = true;
		try {
			// an interrupt handler can reach a suspending import, so it runs as a kernel entry of its own
			const work = kernel.wasm_user_interrupt
				? await WebAssembly.promising(kernel.wasm_user_interrupt)()
				: kernel.wasm_user_work_pending?.();
			if (!work) return value;
			const [sp, tls] = this.userRegs(me);
			await WebAssembly.promising(kernel.wasm_syscall_0)(sp, tls, SYS_GETPID);
			return value;
		} finally {
			me.interrupting = false;
		}
	}

	/**
	 * a software-TLB miss: pages map to themselves for now, so an entry's delta is 0. A page the host
	 * has to bring in first answers -1, and the program parks in mmuFault until it is in place
	 */
	private mmuMiss(tlb: WebAssembly.Memory, address: number): number {
		this.stats.mmuMisses++;
		const page = address >>> 12;
		const pending = this.options.pageIn?.(page, !this.hostCalling);
		if (pending && this.hostCalling) throw new Error(`page ${page} can not be waited for here`);
		if (pending) {
			this.pageFaults.set(page, pending);
			return -1;
		}
		return this.tlbFill(tlb, address);
	}

	private async mmuFault(tlb: WebAssembly.Memory, address: number): Promise<number> {
		const page = address >>> 12;
		this.stats.pageFaults++;
		await this.pageFaults.get(page);
		this.pageFaults.delete(page);
		return this.tlbFill(tlb, address);
	}

	private pageFaults = new Map<number, Promise<void>>();
	/** program code is running from a host call, where a page fault can not park */
	private hostCalling = false;

	/** a valid page table entry: delta 0, bit 0 set */
	private tlbFill(tlb: WebAssembly.Memory, address: number): number {
		new Uint32Array(tlb.buffer)[address >>> 12] = 1;
		return address;
	}

	/**
	 * limits a program's stack pointer to the mapping it is in (scripts/wasm/stack-pass.ts), as a guard
	 * page would: a signal frame on an alternate stack gets that stack's bounds while its handler runs
	 */
	private boundStack(runner: Runner, program: NonNullable<Runner['program']>) {
		const kernel = this.exp(runner);
		if (!program.exports.__gmux_set_stack_limits || !kernel.wasm_user_stack_low) return;
		const sp = program.stackPointer.value;
		const low = kernel.wasm_user_stack_low(sp) >>> 0;
		const high = kernel.wasm_user_stack_high(sp) >>> 0;
		if (!low || !high) return;
		const segments = (program.segments ??= []);
		let at = segments.findIndex((s) => s.low === low);
		if (at < 0) at = segments.push({ low, high }) - 1;
		program.segment = at;
		program.exports.__gmux_set_stack_limits(high, low + STACK_GUARD);
		program.dl?.stackLimits(high, low + STACK_GUARD);
	}

	/**
	 * split stacks (scripts/wasm/stack-pass.ts): a frame allocation left its segment. The segments form
	 * a chain in stack order, and the stack pointer before the allocation says which one the program
	 * is in: after a return that is an older one, found by the most recent segment holding it (two
	 * segments can share a boundary). A frame that fits there stays; one that does not goes to the top
	 * of the next segment in the chain, mapped for the task on first use and reused after, until the
	 * segments reach RLIMIT_STACK, past which it is a stack overflow (SIGSEGV), as with an MMU
	 */
	private stackMove(me: Runner, requested: number): number {
		const program = me.program!;
		const sp = requested >>> 0;
		const current = program.stackPointer.value >>> 0;
		const segments = (program.segments ??= []);
		const holds = (s: { low: number; high: number }, at: number) => at >= s.low && at <= s.high;
		let at = program.segment ?? 0;
		if (!segments[at] || !holds(segments[at]!, current)) {
			at = -1;
			for (let i = Math.min(program.segment ?? 0, segments.length - 1); i >= 0; i--)
				if (holds(segments[i]!, current)) {
					at = i;
					break;
				}
		}
		const frame = current - sp;
		if (at < 0 || frame <= 0) throw new WebAssembly.RuntimeError('stack overflow');
		const set = (i: number) => {
			program.segment = i;
			program.exports.__gmux_set_stack_limits(
				segments[i]!.high,
				segments[i]!.low + STACK_GUARD
			);
			program.dl?.stackLimits(segments[i]!.high, segments[i]!.low + STACK_GUARD);
		};
		if (sp >= segments[at]!.low + STACK_GUARD) {
			set(at);
			return sp;
		}
		let next = segments[at + 1];
		if (!next || next.high - next.low < frame + STACK_GUARD + 64) {
			const size = Math.max(STACK_SEGMENT, (frame + 0x10fff) & ~0xfff);
			const kernel = this.exp(me);
			const tls = program.exports.__get_tls_base?.() ?? kernel.gmux_utls.value;
			// synchronous: the program is mid-frame, and none of these sleeps
			const syscall = (nr: number, ...args: number[]) =>
				Number(kernel[`wasm_syscall_${args.length}`](current, tls, nr, ...args));
			// a next segment too small for this frame, and any past it, hold no live frames
			for (const old of segments.splice(at + 1))
				syscall(SYS_MUNMAP, old.low, old.high - old.low);
			const low = syscall(SYS_MMAP, 0, size, 3, 0x22, -1, 0) >>> 0;
			if (low > 0xfffff000) throw new WebAssembly.RuntimeError('stack overflow');
			// RLIMIT_STACK read into the new segment, the one place with room to spare
			syscall(SYS_PRLIMIT64, 0, RLIMIT_STACK, 0, low);
			const limit = Number(new DataView(this.userMemory(me).buffer).getBigUint64(low, true));
			const total = segments.slice(0, at + 1).reduce((n, s) => n + s.high - s.low, 0) + size;
			if (total > limit) {
				syscall(SYS_MUNMAP, low, size);
				throw new WebAssembly.RuntimeError('stack overflow');
			}
			next = { low, high: low + size };
			segments.push(next);
			this.stats.stackSegments++;
		}
		set(at + 1);
		return (next.high - frame) & ~15;
	}

	/** instantiates the task's executable for its first return to user mode */
	private enterProgram(runner: Runner, clone: boolean): NonNullable<Runner['program']> {
		const kernel = this.exp(runner);
		const tlsBase = kernel.get_user_tls_base();
		// a new process image: nothing loaded at this data start belongs to it, nor a scratch
		// mapping cached for an earlier mm at its mm's address
		if (!clone) {
			this.dls.delete(runner.user!.dataStart);
			this.forkSpills.delete(Number(kernel.wasm_current_mm?.() ?? 0) >>> 0);
		}
		const made = this.program(runner, kernel.get_user_stack_pointer());
		const ux = made.ux;
		runner.program = {
			exports: ux,
			stackPointer: made.global,
			entry: clone ? 'clone' : 'start',
			dl: made.dl
		};
		this.boundStack(runner, runner.program);
		this.hostCalling = true;
		try {
			// a clone shares its parent's data, already relocated and live; relocating it again resets
			// pointers the parent has since changed (a corrupted heap in the parent)
			if (clone) ux.__set_tls_base?.(tlsBase);
			else {
				// a shared instance's later processes start from the first one's data before relocation
				const s = runner.shared;
				const at = runner.user!.dataStart;
				if (s && !s.template)
					s.template = new Uint8Array(
						this.memory.buffer,
						at,
						sharedDataSize(runner.user!.module)
					).slice();
				else if (s) new Uint8Array(this.memory.buffer).set(s.template!, at);
				ux.__wasm_apply_data_relocs?.();
				// the start function copies the main thread's TLS image but leaves its pointers to the loader
				ux.__wasm_apply_tls_relocs?.();
				ux.__wasm_call_ctors?.();
			}
		} finally {
			this.hostCalling = false;
		}
		return runner.program;
	}

	/**
	 * a trap in the task's code, as a fault is on Linux: the signal for it, at its default action
	 * and unblocked, kills the task and leaves the machine running
	 */
	private async fault(runner: Runner, error: Error): Promise<never> {
		const message = error.message;
		const signal = /unreachable/.test(message)
			? SIGILL
			: /divide by zero|remainder by zero|integer overflow/.test(message)
				? SIGFPE
				: message === 'abort'
					? SIGABRT
					: SIGSEGV;
		this.log(`${runner.name} fault: ${message}, signal ${signal}`);
		const kernel = this.exp(runner);
		// a trap that unwound a syscall left the cpu in kernel mode
		if (kernel.wasm_trap_unwound_kernel?.()) this.log(`${runner.name} fault unwound a syscall`);
		const [sp, tls] = this.userRegs(runner);
		// a zeroed k_sigaction (SIG_DFL) and a one-signal set, below the dead frames of the trap
		const at = (sp - 64) & ~15;
		const memory = this.userMemory(runner);
		new Uint8Array(memory.buffer, at, 48).fill(0);
		new DataView(memory.buffer).setUint32(at + 32, 1 << (signal - 1), true);
		const syscall = (nr: number, ...args: number[]) =>
			WebAssembly.promising(kernel[`wasm_syscall_${args.length}`])(sp, tls, nr, ...args);
		await syscall(SYS_RT_SIGACTION, signal, at, 0, 8);
		await syscall(SYS_RT_SIGPROCMASK, SIG_UNBLOCK, at + 32, 0, 8);
		await syscall(SYS_TKILL, Number(await syscall(SYS_GETTID)), signal);
		throw new Error(`${runner.name} survived fatal signal ${signal}`);
	}

	/**
	 * runs the task's signal handler through `promising`, not under the calling import's JS frame, so
	 * its blocking syscalls can suspend; its sigreturn ends it with the `signal_return` trap
	 */
	private async handleSignal(me: Runner, flow: number, rewind?: () => void): Promise<number> {
		// a new thread's first return to user mode: only a clone inherits handlers before its entry runs
		if (!me.program && me.user) this.enterProgram(me, true).early = true;
		const program = me.program;
		if (!program?.exports.__libc_handle_signal)
			throw new Error('signal for a task with no handler entry');
		const kernel = this.exp(me);
		const restore = () => {
			program.stackPointer.value = kernel.get_user_stack_pointer();
			// only programs that link musl's clone export it
			program.exports.__set_tls_base?.(kernel.get_user_tls_base());
			this.boundStack(me, program);
		};
		this.stats.signals++;
		if (this.options.trace) {
			const sp = kernel.get_user_stack_pointer();
			// the frame __libc_handle_signal reads: signal, siginfo, ucontext, handler
			const frame = [0, 4, 8, 12].map((at) =>
				new DataView(this.memory.buffer).getUint32(sp + at, true)
			);
			this.log(
				`signal to ${me.name} flow=${flow} sp=${sp} live=${program.stackPointer.value} frame=${frame}`
			);
		}
		me.handlers++;
		try {
			// a rewinding handler keeps the stack pointer of its park
			const sp = program.stackPointer.value;
			restore();
			if (rewind) {
				program.stackPointer.value = sp;
				rewind();
			}
			const entry = program.exports[`__libc_handle_signal${rewind ? '$resume' : ''}`];
			await WebAssembly.promising(entry)();
			throw new Error('__libc_handle_signal returned');
		} catch (error) {
			if (
				me.unwinding &&
				error instanceof WebAssembly.Exception &&
				(error as { is(tag: unknown): boolean }).is(program.exports.gmux_ckpt)
			)
				return this.unwindSignal(me, flow);
			if (!(error instanceof Trap && error.kind === 'signal_return')) throw error;
			restore();
		} finally {
			me.handlers--;
		}
		if (flow & 2) throw new Trap('signal_return');
		return 0;
	}

	/**
	 * a checkpoint unwound a parked handler: keep its stacks, then unwind the frames it interrupted,
	 * which resume through wasm_user_mode_tail (asyncified, experiments/machine-checkpoint/scripts/build-async.sh)
	 */
	private unwindSignal(me: Runner, flow: number): number {
		const ux = me.program!.exports;
		const userBuf = this.scratch + STACK_BYTES;
		this.header(userBuf, ux.gmux_fp.value - (userBuf + 8));
		ux.gmux_unwinding.value = 0;
		const kernel = me.where === 'kernel' ? this.copyStack(this.scratch) : null;
		if (me.where === 'kernel') this.exp(me).asyncify_stop_unwind();
		me.signal = { flow, where: me.where, kernel, user: this.copyStack(userBuf) };
		me.where = 'kernel';
		return this.beginUnwind(me);
	}

	/** the interrupted frames rewound to wasm_user_mode_tail: rewind the handler inside it */
	private rewindSignal(me: Runner): Promise<number> {
		const saved = me.signal!;
		me.signal = null;
		const kernel = this.exp(me);
		kernel.asyncify_stop_rewind();
		me.where = saved.where;
		// after handleSignal's own kernel calls, which a rewinding kernel would not run
		return this.handleSignal(me, saved.flow, () => {
			if (saved.kernel) {
				new Uint8Array(this.memory.buffer).set(saved.kernel, this.scratch + 8);
				this.header(this.scratch, saved.kernel.byteLength);
				kernel.asyncify_start_rewind(this.scratch);
			}
			const userBuf = this.scratch + STACK_BYTES;
			new Uint8Array(this.memory.buffer).set(saved.user, userBuf + 8);
			const ux = me.program!.exports;
			ux.gmux_fp.value = userBuf + 8 + saved.user.byteLength;
			ux.gmux_unwinding.value = 0;
		});
	}

	private pendingVforks: Vfork[] = [];

	/**
	 * whether a new user task is a pending vfork's child: it starts on exactly its parent's stack
	 * pointer, and without an MMU no two processes share a stack address. The new task can run on
	 * any cpu, so the task that switched to it says nothing
	 */
	private adoptVforkChild(runner: Runner): boolean {
		const sp = this.exp(runner).get_user_stack_pointer();
		const at = this.pendingVforks.findIndex((v) => v.sp === sp);
		if (at < 0) return false;
		const vfork = this.pendingVforks.splice(at, 1)[0]!;
		vfork.child = runner;
		runner.vforkOf = vfork;
		return true;
	}

	/** the user stack pointer and TLS a syscall from this runner's program passes the kernel */
	private userRegs(runner: Runner): [number, number] {
		const program = runner.program!;
		const tls = program.exports.__get_tls_base?.() ?? this.exp(runner).gmux_utls.value;
		return [program.stackPointer.value, tls];
	}

	/**
	 * fork, from musl's _Fork: the first call spills the program's frames (it must be evacuable,
	 * experiments/evacuation/scripts/evacuate.ts --resume) and forkUnwound forks the task; the
	 * frames resume in the parent and in the child, whose re-issued call gets the pid or 0
	 */
	private fork(me: Runner): number {
		if (me.forkResult !== undefined) {
			const value = me.forkResult;
			me.forkResult = undefined;
			return value;
		}
		const program = me.program!;
		const ux = program.exports;
		if (!evacuable(ux)) return -38;
		const spill = this.forkSpill(me);
		if (!spill) return -12;
		me.forkSp = program.stackPointer.value;
		ux.gmux_fp.value = spill;
		ux.gmux_unwinding.value = 1;
		me.forking = true;
		return 0;
	}

	/**
	 * `reenterAfterRestore`: once its time has come, a fuel yield returns with the program unwinding,
	 * so its frames spill as for a fork and userChain resumes them in the same instance, where the
	 * re-issued yield returns `value`
	 */
	private reenter(me: Runner, value: number): number {
		if (me.reenterAt === undefined || me.unwinding || me.rewinding || this.now() < me.reenterAt)
			return value;
		const program = me.program;
		// a handler's frames are not userChain's, and a vfork child runs its parent's instance
		if (
			!program ||
			me.handlers ||
			me.vfork ||
			me.vforkOf ||
			me.shared ||
			!evacuable(program.exports)
		)
			return value;
		me.reenterAt = undefined;
		const spill = this.forkSpill(me);
		if (!spill) return value;
		me.reenterSp = program.stackPointer.value;
		program.exports.gmux_fp.value = spill;
		program.exports.gmux_unwinding.value = 1;
		me.reentering = true;
		me.reentered = value;
		return value;
	}

	/** a mapping of the process's own for its spilled frames, made once and reused while it lasts */
	private forkSpill(me: Runner): number {
		const kernel = this.exp(me);
		const mm = Number(kernel.wasm_current_mm()) >>> 0;
		const known = this.forkSpills.get(mm);
		// a dead process's mm and mapping addresses come back; a smaller mapping there is not ours
		if (
			known &&
			kernel.wasm_user_stack_low(known) >>> 0 === known &&
			(!kernel.wasm_user_stack_high ||
				kernel.wasm_user_stack_high(known) >>> 0 >= known + FORK_SPILL)
		)
			return known;
		const [sp, tls] = this.userRegs(me);
		// synchronous: the program is in its fork call, and an anonymous mapping does not sleep
		const low =
			Number(kernel.wasm_syscall_6(sp, tls, SYS_MMAP, 0, FORK_SPILL, 3, 0x22, -1, 0)) >>> 0;
		if (low > 0xfffff000) return 0;
		this.forkSpills.set(mm, low);
		return low;
	}

	/** the frames have spilled: clone the task (the kernel copies the mappings into the child's memory) */
	private async forkUnwound(me: Runner) {
		me.forking = false;
		const program = me.program!;
		const ux = program.exports;
		ux.gmux_unwinding.value = 0;
		const fork: Fork = {
			parent: me,
			top: ux.gmux_fp.value,
			sp: me.forkSp!,
			entry: program.entry,
			globals: Object.keys(ux)
				.filter((k) => /^gmux_g\d+$/.test(k))
				.map((k) => [k, Number((ux[k] as WebAssembly.Global).value)]),
			segments: program.segments?.map((s) => ({ ...s })),
			segment: program.segment
		};
		program.stackPointer.value = fork.sp;
		const kernel = this.exp(me);
		const tls = ux.__get_tls_base?.() ?? kernel.gmux_utls.value;
		this.pendingFork = fork;
		let pid: number;
		try {
			pid = Number(
				await WebAssembly.promising(kernel.wasm_syscall_5)(
					fork.sp,
					tls,
					SYS_CLONE,
					SIGCHLD,
					0,
					0,
					0,
					0
				)
			);
		} finally {
			this.pendingFork = null;
		}
		me.forkResult = pid;
		this.stats.forks++;
	}

	/** a task whose mm the kernel mirrored for a fork: the child of that fork */
	private adoptForkChild(runner: Runner): boolean {
		if (!this.forkChildren.size) return false;
		const mm = Number(this.exp(runner).wasm_current_mm?.() ?? 0) >>> 0;
		const fork = this.forkChildren.get(mm);
		if (!fork) return false;
		this.forkChildren.delete(mm);
		runner.forkOf = fork;
		return true;
	}

	/** the child's first run: its program over its own memory, with the parent's globals, resuming the frames */
	private async forkChildStarts(child: Runner) {
		const fork = child.forkOf!;
		child.forkOf = null;
		const made = this.program(child, fork.sp);
		const ux = made.ux;
		for (const [name, value] of fork.globals) (ux[name] as WebAssembly.Global).value = value;
		ux.gmux_fp.value = fork.top;
		ux.gmux_unwinding.value = 0;
		child.program = {
			exports: ux,
			stackPointer: made.global,
			entry: fork.entry,
			dl: made.dl,
			segments: fork.segments?.map((s) => ({ ...s })),
			segment: fork.segment
		};
		child.forkResult = 0;
		await this.userChain(child, false, true);
	}

	/** the parent's side of vfork: its clone runs on a stack of its own and waits there for the child */
	private vforkStart(env: number): Promise<number> {
		const parent = this.current!;
		if (!this.shared) throw new Error('vfork needs a shared kernel instance');
		const [sp, tls] = this.userRegs(parent);
		return new Promise<number>((start) => {
			const vfork: Vfork = { parent, child: null, env, sp, start, borrowed: null };
			parent.vfork = vfork;
			this.pendingVforks.push(vfork);
			WebAssembly.promising(this.exp(parent).wasm_syscall_5)(
				sp,
				tls,
				SYS_CLONE,
				CLONE_VM | CLONE_VFORK | SIGCHLD,
				0,
				0,
				0,
				0
			).then(
				(pid: number) => this.vforkParentBack(vfork, Number(pid)),
				(error: unknown) => this.finished(parent, error)
			);
		});
	}

	/** the child's first run: the parent's stack continues as the child */
	private vforkChildStarts(child: Runner) {
		const vfork = child.vforkOf!;
		child.program = vfork.parent.program;
		// a shared instance holds whoever ran last: the child continues with the parent's values,
		// which stay saved for the parent's own resume
		child.shared = vfork.parent.shared;
		const saved = vfork.parent.sharedSaved;
		if (child.shared && saved) child.shared.globals.forEach((g, i) => (g.value = saved[i]!));
		vfork.start(0);
	}

	/**
	 * the child's execve or _exit, on a stack of its own so none of its kernel frames sit on the
	 * parent's; a failed execve returns the error to the child on the shared stack
	 */
	private vforkTerminal(nr: number, args: number[]): Promise<number> {
		const child = this.current!;
		const vfork = child.vforkOf;
		if (!vfork) throw new Error(`${child.name}: execve or _exit hook outside a vfork child`);
		return new Promise<number>((resolve) => {
			vfork.borrowed = resolve;
			if (nr === SYS_EXIT_GROUP) child.vforkOf = null;
			const [sp, tls] = this.userRegs(child);
			const call = this.exp(child)[`wasm_syscall_${args.length}`];
			WebAssembly.promising(call)(sp, tls, nr, ...args).then(
				(result: number) => {
					if (nr === SYS_EXIT_GROUP)
						return this.finished(child, new Error('exit_group returned'));
					if (vfork.borrowed !== resolve) return;
					vfork.borrowed = null;
					resolve(Number(result));
				},
				(error: unknown) => {
					if (!(error instanceof Trap && error.kind === 'reload_program'))
						return this.finished(child, error);
					child.vforkOf = null;
					child.program = null;
					void this.userChain(child, false).catch((e) => this.finished(child, e));
				}
			);
		});
	}

	/** the parent's clone returned: give it its stack back, with the child's pid */
	private vforkParentBack(vfork: Vfork, pid: number) {
		const { parent, child } = vfork;
		parent.vfork = null;
		this.pendingVforks = this.pendingVforks.filter((v) => v !== vfork);
		if (!child) return vfork.start(pid);
		if (vfork.borrowed) {
			const borrowed = vfork.borrowed;
			vfork.borrowed = null;
			return borrowed(pid);
		}
		// the child died holding the stack (a signal, or exit_group without _exit): unwind it to the setjmp
		const fail = child.fail;
		child.resume = null;
		child.fail = null;
		child.vforkOf = null;
		if (!fail)
			throw new Error(`vfork: ${child.name} holds the parent's stack and is not parked`);
		fail(this.longjmp(parent, vfork.env, pid));
	}

	/** the exception LLVM's setjmp lowering catches, as `longjmp(env, value)` would throw it */
	private longjmp(runner: Runner, env: number, value: number): WebAssembly.Exception {
		const program = runner.program!;
		const at = (program.stackPointer.value - 16) & ~7;
		const view = new DataView(this.userMemory(runner).buffer);
		view.setUint32(at, env, true);
		view.setInt32(at + 4, value, true);
		return new WebAssembly.Exception(program.exports.__c_longjmp, [at]);
	}

	private ensureScratch() {
		if (!this.scratch) this.scratch = this.memory.grow(SCRATCH_PAGES) * 0x10000;
	}

	private header(at: number, used: number) {
		const view = new DataView(this.memory.buffer);
		view.setUint32(at, at + 8 + used, true);
		view.setUint32(at + 4, at + STACK_BYTES, true);
	}

	/**
	 * called as a parked stack resumes for a checkpoint: start asyncify on the kernel. An asyncified
	 * program unwinds with it; an evacuable one (experiments/evacuation/scripts/evacuate.ts)
	 * throws when the kernel returns into it, each frame writing its live locals from gmux_fp up
	 */
	private beginUnwind(runner: Runner): number {
		const kernelBuf = this.scratch;
		const userBuf = this.scratch + STACK_BYTES;
		if (runner.where === 'kernel') {
			this.header(kernelBuf, 0);
			this.exp(runner).asyncify_start_unwind(kernelBuf);
		}
		if (runner.program && evacuable(runner.program.exports)) {
			runner.program.exports.gmux_fp.value = userBuf + 8;
			runner.program.exports.gmux_unwinding.value = 1;
		} else if (runner.program) {
			this.header(userBuf, 0);
			runner.program.exports.asyncify_start_unwind(userBuf);
		}
		return 0;
	}

	private stacks = new Map<Runner, { kernel: Uint8Array | null; user: Uint8Array | null }>();
	/** each process's side modules (dlopen), by the data start of its program */
	private dls = new Map<number, DlProcess>();
	private dlMisses: DlMisses;
	/** shared instances, by program hash */
	private sharedPrograms = new Map<string, SharedProgram>();
	/** pages a lazy restore has not written yet, by owner tag, and where they come from */
	private deferred = new Map<number, number[]>();
	private deferredSource:
		((start: number, end: number) => Uint8Array | Promise<Uint8Array>) | null = null;

	/** fills the kernel started for another process, by owner tag, which a task of the owner awaits */
	private touching = new Map<number, Promise<void>>();

	/** writes a process's deferred pages before any of its tasks runs again */
	private async fillDeferred(tag: number) {
		await this.touching.get(tag);
		const pages = this.deferred.get(tag);
		if (!pages) return;
		this.deferred.delete(tag);
		for (let i = 0; i < pages.length;) {
			let j = i;
			while (j + 1 < pages.length && pages[j + 1] === pages[j]! + 1) j++;
			const [start, end] = [pages[i]! * 0x1000, (pages[j]! + 1) * 0x1000];
			new Uint8Array(this.memory.buffer).set(await this.deferredSource!(start, end), start);
			i = j + 1;
		}
		this.stats.filledPages += pages.length;
		if (!this.deferred.size) this.deferredSource = null;
	}

	/** writes the deferred pages in [addr, addr + len) now, whichever processes own them */
	private async fillDeferredRange(addr: number, len: number) {
		if (!this.deferred.size || !len) return;
		const [first, last] = [addr >>> 12, (addr + len - 1) >>> 12];
		for (const [tag, pages] of [...this.deferred]) {
			const hit = pages.filter((p) => p >= first && p <= last);
			if (!hit.length) continue;
			// out of the list first: a later fill must not overwrite what the kernel writes now
			const rest = pages.filter((p) => p < first || p > last);
			if (rest.length) this.deferred.set(tag, rest);
			else this.deferred.delete(tag);
			const source = this.deferredSource!;
			const fill = (async () => {
				await this.touching.get(tag);
				for (const page of hit)
					new Uint8Array(this.memory.buffer).set(
						await source(page * 0x1000, (page + 1) * 0x1000),
						page * 0x1000
					);
			})();
			this.touching.set(tag, fill);
			await fill;
			if (this.touching.get(tag) === fill) this.touching.delete(tag);
			this.stats.filledPages += hit.length;
			this.stats.touchedPages += hit.length;
		}
		if (!this.deferred.size && !this.touching.size) this.deferredSource = null;
	}

	/** fork children's own memories, by the kernel's mm (kernel patch 0015) */
	private privateMemories = new Map<number, WebAssembly.Memory>();
	/** forks whose child task has not started yet, by the child's mm */
	private forkChildren = new Map<number, Fork>();
	/** the fork in the middle of its clone, whose child's mm takes it */
	private pendingFork: Fork | null = null;
	/** each process's spill mapping for fork frames, by mm */
	private forkSpills = new Map<number, number>();

	private lastDomain: Domain | null = null;
	private readonly domains = new WeakMap<WebAssembly.Memory, Domain>();

	/** the domain over a memory, the last one used kept at hand for the next crossing */
	private domain(memory: WebAssembly.Memory): Domain {
		if (this.lastDomain?.memory === memory) return this.lastDomain;
		let domain = this.domains.get(memory);
		if (!domain)
			this.domains.set(memory, (domain = new Domain(memory, READ | WRITE, this.memory)));
		return (this.lastDomain = domain);
	}

	/** the memory a task's program runs on: its own after a fork, else the machine's */
	private userMemory(runner: Runner): WebAssembly.Memory {
		if (!this.privateMemories.size) return this.memory;
		const mm = Number(this.exp(runner).wasm_current_mm?.() ?? 0) >>> 0;
		return this.privateMemories.get(mm) ?? this.memory;
	}

	private dlProcess(dataStart: number): DlProcess {
		let dl = this.dls.get(dataStart);
		if (!dl) {
			dl = new DlProcess(this.memory, this.options.registry, this.options.sha256, dataStart, {
				misses: this.dlMisses,
				interpreter: !!this.options.interpret,
				onMiss: (exe, lib) => this.stats.dlMisses.push(`${lib} for ${exe}`)
			});
			this.dls.set(dataStart, dl);
		}
		return dl;
	}

	private copyStack(at: number): Uint8Array {
		const end = new DataView(this.memory.buffer).getUint32(at, true);
		return new Uint8Array(this.memory.buffer).slice(at + 8, end);
	}

	private endUnwind(runner: Runner) {
		if (!runner.unwinding) return;
		const kernel = runner.where === 'kernel' ? this.copyStack(this.scratch) : null;
		const ux = runner.program?.exports;
		if (ux && evacuable(ux)) {
			this.header(
				this.scratch + STACK_BYTES,
				ux.gmux_fp.value - (this.scratch + STACK_BYTES + 8)
			);
			ux.gmux_unwinding.value = 0;
		}
		const user = runner.program ? this.copyStack(this.scratch + STACK_BYTES) : null;
		if (runner.where === 'kernel') this.exp(runner).asyncify_stop_unwind();
		if (ux && !evacuable(ux)) ux.asyncify_stop_unwind();
		runner.unwinding = false;
		runner.checkpointed = true;
		this.stacks.set(runner, { kernel, user });
		const done = this.unwound;
		this.unwound = null;
		done?.();
	}

	/**
	 * turns every parked stack into bytes and returns the machine as data. The machine cannot run
	 * afterwards; continue from `Machine.restore(options, snapshot)`. `memory` is a view over this
	 * machine's memory, not a copy, so a caller persists it before dropping the machine
	 */
	async checkpoint(): Promise<Snapshot> {
		// a task the kernel released can still hold a turn in the ready queue, which a live machine
		// gives it; dropped from the snapshot, a cpu waits forever for the switch it would make
		const all = [
			...this.runners.values(),
			...this.ready.filter((r) => this.runners.get(r.id) !== r)
		];
		// ponytail: a fork child's own memory is not in the snapshot yet
		if (this.privateMemories.size)
			throw new Error('checkpoint: fork children with their own memory are not saved yet');
		// ponytail: a stream is a socket in the kernel and queues here; closing them at a checkpoint is part 2
		if (this.net.open)
			throw new Error('checkpoint: streams are open to the machine and are not saved');
		// ponytail: shared instances hold one process's values at a time; saving each runner's
		// set and rebuilding the template on restore would lift this
		if (this.sharedPrograms.size)
			throw new Error('checkpoint: shared program instances are not saved yet');
		if (!this.options.asyncify || !this.shared)
			throw new Error('checkpoint needs asyncify and a shared kernel');
		if (this.running) throw new Error('checkpoint while the pump runs');
		// its stacks are already bytes, or are being made so: a second snapshot would hold none of them
		if (this.spent || this.checkpointing)
			throw new Error('checkpoint: this machine has checkpointed already');
		if (all.some((r) => r.vfork || r.vforkOf)) throw new Error('checkpoint during vfork');
		if (all.some((r) => r.syncing) || this.pendingFiles)
			throw new Error(
				'checkpoint during a file sync or before a restore wrote its files back'
			);
		// ponytail: one handler per task, from a syscall's return; nested handlers would stack HandlerStacks
		if (
			all.some(
				(r) =>
					r.handlers > 1 ||
					(r.handlers && (r.interrupting || !r.program || !evacuable(r.program.exports)))
			)
		)
			throw new Error(
				'checkpoint during a nested, interrupt-time or asyncified signal handler'
			);
		// the guarded BusyBox and katybug are not asyncified: nothing could unwind their frames
		if (
			all.some(
				(r) =>
					r.program &&
					!r.halted &&
					!evacuable(r.program.exports) &&
					!r.program.exports.asyncify_start_unwind
			)
		)
			throw new Error('checkpoint while a program without asyncify runs');
		this.checkpointing = true;
		this.ensureScratch();
		// a machine restored lazily saves every page: what its parked processes never brought in too
		for (const tag of [...this.deferred.keys()]) await this.fillDeferred(tag);
		await Promise.all(this.touching.values());
		const now = this.now();
		// the owner of every page (kernel patch 0014), so a restore can leave idle processes' pages out
		const table = Number(this.exp(this.cpuZero).wasm_owner_table?.() ?? 0) >>> 0;
		const owners = table
			? new Uint16Array(
					this.memory.buffer.slice(
						table,
						table + (this.memory.buffer.byteLength >>> 12) * 2
					)
				)
			: undefined;
		const programs = new Map<Runner, SavedRunner['program']>();
		for (const runner of all) {
			if (!runner.program) continue;
			const globals = Object.entries(runner.program.exports)
				.filter(([name]) => name.startsWith('gmux_g'))
				.map(([name, g]) => [name, (g as WebAssembly.Global).value] as [string, number]);
			programs.set(runner, {
				entry: runner.program.entry,
				stackPointer: runner.program.stackPointer.value,
				globals
			});
		}
		for (const runner of all) {
			if (!runner.started || runner.halted || !runner.resume) continue;
			const resume = runner.resume;
			runner.resume = null;
			this.current = runner;
			if (runner.saved) this.taskGlobals.forEach((g, i) => (g.value = runner.saved![i]));
			runner.unwinding = true;
			const done = new Promise<void>((r) => (this.unwound = r));
			resume(0);
			// wasm unwinds inside microtasks; workerd may never run the continuation of an entry started by an
			// earlier request, so after one macrotask the checkpoint finishes the unwind itself
			await Promise.race([done, new Promise<void>((r) => setTimeout(r, 0))]);
			if (runner.unwinding) this.endUnwind(runner);
			this.current = null;
		}
		const runners: SavedRunner[] = all.map((r) => ({
			id: r.id,
			name: r.name,
			entry: r.entry,
			started: r.started,
			value: r.value,
			idle: r.idle
				? {
						word: r.idle.word,
						remaining:
							r.idle.deadline < 0n
								? null
								: String(r.idle.deadline > now ? r.idle.deadline - now : 0n)
					}
				: null,
			halted: r.halted,
			kill: r.kill,
			saved: r.saved,
			where: r.where,
			user: r.user
				? { hash: r.user.hash, dataStart: r.user.dataStart, tableStart: r.user.tableStart }
				: null,
			program: programs.get(r) ?? null,
			kernelStack: this.stacks.get(r)?.kernel ?? null,
			userStack: this.stacks.get(r)?.user ?? null,
			tag: r.user && owners ? owners[r.user.dataStart >>> 12] : undefined,
			signal: r.signal ?? null,
			released: this.runners.get(r.id) !== r || undefined
		}));
		this.spent = true;
		// the page allocator's free pages hold dead bytes (kernel patch 0020); zeroed, they save as nothing
		const free = Number(this.exp(this.cpuZero).wasm_free_pages?.() ?? 0) >>> 0;
		if (free) {
			const bytes = new Uint8Array(this.memory.buffer);
			// the frame count first, then a bit per frame
			const frames = Math.min(
				new Uint32Array(this.memory.buffer, free, 1)[0]!,
				bytes.byteLength >>> 12
			);
			const words = new Uint32Array(this.memory.buffer, free + 4, Math.ceil(frames / 32));
			let pages = 0;
			for (let w = 0; w < words.length; w++)
				for (let bits = words[w]!; bits; bits &= bits - 1) {
					const page = w * 32 + (31 - Math.clz32(bits & -bits));
					if (page >= frames) break;
					bytes.fill(0, page * 0x1000, (page + 1) * 0x1000);
					pages++;
				}
			this.stats.freePages = pages;
		}
		return {
			version: 1,
			memory: new Uint8Array(this.memory.buffer),
			scratch: this.scratch,
			core: this.coreBase || undefined,
			now: String(now),
			input: [...this.input],
			ready: this.ready.map((r) => r.id),
			readyAt: this.ready.map((r) => all.indexOf(r)),
			cpuZero: this.cpuZero.id,
			runners,
			stats: {
				...this.stats,
				unknownExecutables: [...this.stats.unknownExecutables],
				dlMisses: [...this.stats.dlMisses],
				interpretedStarts: [...this.stats.interpretedStarts]
			},
			dl: [...this.dls.values()]
				.filter((d) => d.libs.length || d.slots.length)
				.map((d) => d.save()),
			owners,
			syncWrites: this.syncWrites || undefined,
			ports: this.net.listeners
		};
	}

	/**
	 * rebuilds a machine from a snapshot in fresh instances and rewinds every stack into its park.
	 * `image`, when given, writes the memory straight into the machine instead of snapshot.memory, so
	 * a large machine never needs a second full copy of itself to restore
	 */
	static restore(
		options: MachineOptions,
		snapshot: Snapshot,
		image?: { byteLength: number; write(into: Uint8Array): void },
		lazy?: {
			byteLength: number;
			read(start: number, end: number): Uint8Array | Promise<Uint8Array>;
		}
	): Promise<Machine> {
		return Machine.rebuild(options, snapshot, image, lazy, false);
	}

	/**
	 * continues a machine that has just checkpointed, in the memory it checkpointed from, which
	 * `options.memory` must be: that memory already is the snapshot's image, so nothing is copied or
	 * read back
	 */
	static resume(options: MachineOptions, snapshot: Snapshot): Promise<Machine> {
		if (options.memory?.buffer.byteLength !== snapshot.memory.byteLength)
			throw new Error('resume: options.memory must be the memory the snapshot was taken in');
		return Machine.rebuild(options, snapshot, undefined, undefined, true);
	}

	private static async rebuild(
		options: MachineOptions,
		snapshot: Snapshot,
		image: { byteLength: number; write(into: Uint8Array): void } | undefined,
		lazy:
			| {
					byteLength: number;
					read(start: number, end: number): Uint8Array | Promise<Uint8Array>;
			  }
			| undefined,
		inPlace: boolean
	): Promise<Machine> {
		const machine = new Machine(
			options,
			(image ?? lazy ?? snapshot.memory).byteLength / 0x10000,
			inPlace
		);
		if (options.restoreFiles?.length) machine.pendingFiles = [...options.restoreFiles];
		for (const f of options.restoreFiles ?? []) if (!f.removed) machine.syncedPaths.add(f.path);
		machine.syncWrites = !!snapshot.syncWrites;
		machine.syncMark = BigInt(snapshot.now);
		const into = new Uint8Array(machine.memory.buffer);
		// a lazy restore writes the kernel's, free and shared pages now, and each parked process's
		// own pages when one of its tasks is about to run
		const owners = lazy && snapshot.owners;
		const tags = new Set(
			owners ? snapshot.runners.map((r) => r.tag ?? 0).filter((t) => t > 0 && t < 0x8000) : []
		);
		if (owners && tags.size) {
			for (let page = 0; page < owners.length; page++) {
				const tag = owners[page]!;
				if (tags.has(tag)) {
					let list = machine.deferred.get(tag);
					if (!list) machine.deferred.set(tag, (list = []));
					list.push(page);
				}
			}
			let page = 0;
			const total = into.byteLength >>> 12;
			while (page < total) {
				if (page < owners.length && tags.has(owners[page]!)) {
					page++;
					continue;
				}
				let end = page;
				while (end < total && !(end < owners.length && tags.has(owners[end]!))) end++;
				into.set(await lazy.read(page * 0x1000, end * 0x1000), page * 0x1000);
				page = end;
			}
			machine.deferredSource = (start, end) => lazy.read(start, end);
		} else if (lazy) into.set(await lazy.read(0, into.byteLength));
		else if (image) image.write(into);
		else if (!inPlace) into.set(snapshot.memory);
		const behind = BigInt(snapshot.now) - machine.now();
		if (behind > 0n) machine.clockOffset = behind;
		Object.assign(machine.stats, snapshot.stats);
		machine.stats.deferredPages = [...machine.deferred.values()].reduce(
			(n, l) => n + l.length,
			0
		);
		machine.stats.filledPages = 0;
		machine.input = [...snapshot.input];
		machine.net.restore(snapshot.ports);
		machine.scratch = snapshot.scratch;
		if (options.core) {
			if (snapshot.core === undefined)
				throw new Error(
					'restore: the snapshot has no core region; restore without options.core'
				);
			machine.startCore(snapshot.core);
		}
		machine.instantiate(machine.cpuZero);
		for (const saved of snapshot.dl ?? []) machine.dlProcess(saved.dataStart).load(saved);
		const now = machine.now();
		const made: Runner[] = [];
		for (const saved of snapshot.runners) {
			const runner =
				saved.id === snapshot.cpuZero && !saved.released
					? machine.cpuZero
					: machine.runner(saved.name, saved.entry);
			made.push(runner);
			machine.stats.runners = snapshot.stats.runners;
			Object.assign(runner, {
				id: saved.id,
				name: saved.name,
				entry: saved.entry,
				started: saved.started,
				value: saved.value,
				halted: saved.halted,
				kill: saved.kill,
				saved: saved.saved,
				where: saved.where,
				idle: saved.idle
					? {
							word: saved.idle.word,
							deadline:
								saved.idle.remaining === null
									? -1n
									: now + BigInt(saved.idle.remaining)
						}
					: null,
				instance: machine.shared
			});
			if (saved.user) {
				const module = options.registry.get(saved.user.hash);
				if (!module) throw new Error(`restore: no module for ${saved.user.hash}`);
				runner.user = { module, ...saved.user };
			}
			runner.tag = saved.tag;
			runner.signal = saved.signal ?? null;
			if (!saved.released) machine.runners.set(saved.id, runner);
		}
		machine.reindexIdle();
		for (const [i, saved] of snapshot.runners.entries()) {
			const runner = made[i]!;
			const entry = saved.entry;
			if (!saved.started) {
				if (entry.kind === 'fork')
					runner.resume = () => void machine.startTask(runner, entry.prev, entry.next);
				if (entry.kind === 'secondary')
					runner.resume = () => void machine.startSecondary(runner, entry.idle);
				continue;
			}
			if (saved.halted || (!saved.kernelStack && !saved.userStack)) continue;
			machine.current = runner;
			if (saved.saved) machine.taskGlobals.forEach((g, i) => (g.value = saved.saved![i]));
			const kernel = machine.exp(runner);
			if (saved.kernelStack) {
				new Uint8Array(machine.memory.buffer).set(saved.kernelStack, snapshot.scratch + 8);
				machine.header(snapshot.scratch, saved.kernelStack.byteLength);
				kernel.asyncify_start_rewind(snapshot.scratch);
			}
			if (saved.program) {
				const made = machine.program(runner, saved.program.stackPointer);
				for (const [name, value] of saved.program.globals)
					(made.ux[name] as WebAssembly.Global).value = value;
				runner.program = {
					exports: made.ux,
					stackPointer: made.global,
					entry: saved.program.entry,
					dl: made.dl
				};
				new Uint8Array(machine.memory.buffer).set(
					saved.userStack!,
					snapshot.scratch + STACK_BYTES + 8
				);
				machine.header(snapshot.scratch + STACK_BYTES, saved.userStack!.byteLength);
				if (evacuable(made.ux)) {
					made.ux.gmux_fp.value =
						snapshot.scratch + STACK_BYTES + 8 + saved.userStack!.byteLength;
					made.ux.gmux_unwinding.value = 0;
					if (options.reenterAfterRestore !== undefined)
						runner.reenterAt =
							machine.now() + BigInt(Math.round(options.reenterAfterRestore * 1e6));
				} else made.ux.asyncify_start_rewind(snapshot.scratch + STACK_BYTES);
			}
			runner.rewinding = true;
			const reached = new Promise<Runner>((r) => (machine.suspended = r));
			if (saved.program)
				void machine
					.userChain(runner, false, true)
					.catch((error) => machine.finished(runner, error));
			else if (entry.kind === 'boot')
				void machine.enter(runner, () => WebAssembly.promising(kernel._start)(), '_start');
			else if (entry.kind === 'secondary')
				void machine.startSecondary(runner, entry.idle, true);
			else void machine.startTask(runner, entry.prev, entry.next, true);
			await reached;
			machine.current = null;
		}
		machine.ready.push(
			...(snapshot.readyAt
				? snapshot.readyAt.map((i) => made[i]!)
				: snapshot.ready.map((id) => machine.runners.get(id)!).filter(Boolean))
		);
		// kernel patch 0023: a checkpoint can be restored more than once (a shipped image, a copied
		// store), and the clock ran on over the pause; the kernel rekeys its crng and resets its stall
		// detectors, as a resumed virtual machine does
		if (!inPlace) {
			const restored = machine.exp(machine.cpuZero).wasm_restored;
			if (restored) {
				restored();
				machine.stats.restoreHooks++;
			}
		}
		return machine;
	}

	/**
	 * keyboard input; raises the console interrupt, or waits for the driver's poll on an older
	 * kernel
	 */
	type(text: string) {
		this.input.push(...new TextEncoder().encode(text));
		this.raiseConsole();
	}

	/**
	 * kernel patch 0016: input raises the console's interrupt on the interrupt cpu's idle word, so
	 * the driver wakes once per batch instead of polling. A kernel without the export polls as before
	 */
	private raiseConsole() {
		// before the first run there is no kernel to ask; the interrupt cpu's first idle raises it
		if (!this.input.length || !this.cpuZero.instance) return;
		const irq = this.exp(this.cpuZero).wasm_console_irq?.();
		if (irq === undefined) return;
		const cpu = [...this.runners.values()].find((r) => r.name === `cpu${IRQ_CPU}`);
		const word = cpu?.idle?.word ?? this.irqWord;
		// before the interrupt cpu first idles, its first idle raises it
		if (word === null) return;
		Atomics.or(new BigInt64Array(this.memory.buffer), word / 8, 1n << BigInt(irq));
		this.stats.consoleRaises++;
	}

	/** changes whenever a stream gains something to read or its guest end closes, which a pump waiting on a stream can end its turn at */
	get netActivity(): number {
		return this.net.activity;
	}

	/** raises the relay's interrupt for any stream that has room again; the site calls it between steps */
	netPoll() {
		this.net.poll();
	}

	/** streams opened to the machine's listeners that are not finished with */
	get openStreams(): number {
		return this.net.open;
	}

	/** whether a program in the machine listens on `port` (kernel patch 0031) */
	listening(port: number): boolean {
		return this.net.listening(port);
	}

	/**
	 * opens a stream to the program listening on `port`: the kernel connects a socket to it and the
	 * program accepts an ordinary connection. Throws when nothing listens there
	 */
	ingress(port: number): IngressStream {
		return this.net.connect(port);
	}

	/** kernel patch 0031: the relay thread is woken by an interrupt, as the console is */
	private raiseNet() {
		if (!this.cpuZero.instance) return;
		const irq = this.exp(this.cpuZero).wasm_net_irq?.();
		if (irq === undefined) return;
		const cpu = [...this.runners.values()].find((r) => r.name === `cpu${IRQ_CPU}`);
		const word = cpu?.idle?.word ?? this.irqWord;
		if (word === null) return;
		Atomics.or(new BigInt64Array(this.memory.buffer), word / 8, 1n << BigInt(irq));
	}

	/** the interrupt cpu's pending-interrupt word, once it has idled */
	private irqWord: number | null = null;

	// #region idle cpus
	/** cpus parked on an interrupt word or a timer, in the order `runners` lists them */
	private readonly idlers: Runner[] = [];
	/**
	 * the waits that have a deadline, earliest first (a binary heap); one whose cpu has woken or
	 * waited again is skipped when it reaches the top
	 */
	private readonly timers: Idle[] = [];
	private words = new Int32Array(0);
	private wordsOf: ArrayBufferLike | null = null;
	private seqs = 0;
	private core: Core | null = null;
	/** where the core's region starts in memory, or 0 */
	private coreBase = 0;
	/** the runners the core's tables name, by slot */
	private readonly slots: Runner[] = [];

	/** starts the C core over the pages at `base`, which the machine reserved before the kernel booted */
	private startCore(base: number) {
		this.coreBase = base;
		this.core = loadCore(this.options.core!, this.memory, base);
	}

	/** tables for the idle cpus a restore brought back, in the order `runners` lists them */
	private reindexIdle() {
		for (const runner of this.runners.values())
			if (runner.idle) this.arm(runner, runner.idle.word, runner.idle.deadline);
	}

	/** parks a cpu on `word` (an address) until it is raised or `deadline` passes; negative: no deadline */
	private arm(runner: Runner, word: number, deadline: bigint) {
		if (runner.idle) this.unindex(runner);
		const idle: Idle = { word, deadline, runner };
		runner.idle = idle;
		const core = this.core;
		if (core) {
			if (runner.slot < 0) {
				runner.slot = this.slots.length;
				this.slots.push(runner);
			}
			if (core.core_idle(runner.slot, runner.seq, word, deadline) < 0)
				throw new Error('core: the idle table is full');
			return;
		}
		const list = this.idlers;
		let at = list.push(runner) - 1;
		for (; at > 0 && list[at - 1]!.seq > runner.seq; at--) list[at] = list[at - 1]!;
		list[at] = runner;
		if (deadline < 0n) return;
		// waits that woke by their word leave their entries behind until they surface
		if (this.timers.length > 4 * list.length + 64) {
			const live = this.timers.filter((t) => t.runner.idle === t);
			this.timers.length = 0;
			for (const t of live) this.pushTimer(t);
		}
		this.pushTimer(idle);
	}

	private pushTimer(idle: Idle) {
		const timers = this.timers;
		let at = timers.push(idle) - 1;
		while (at > 0) {
			const parent = (at - 1) >> 1;
			if (timers[parent]!.deadline <= idle.deadline) break;
			timers[at] = timers[parent]!;
			at = parent;
		}
		timers[at] = idle;
	}

	/** the earliest deadline among the cpus still waiting, or null */
	private soonest(): bigint | null {
		const timers = this.timers;
		while (timers.length && timers[0]!.runner.idle !== timers[0]) {
			const last = timers.pop()!;
			if (!timers.length) break;
			let at = 0;
			for (;;) {
				let child = 2 * at + 1;
				if (child >= timers.length) break;
				if (
					child + 1 < timers.length &&
					timers[child + 1]!.deadline < timers[child]!.deadline
				)
					child++;
				if (last.deadline <= timers[child]!.deadline) break;
				timers[at] = timers[child]!;
				at = child;
			}
			timers[at] = last;
		}
		return timers.length ? timers[0]!.deadline : null;
	}

	/** takes a runner out of the idle tables */
	private unindex(runner: Runner) {
		if (!runner.idle) return;
		if (this.core) {
			if (runner.slot >= 0) this.core.core_cancel(runner.slot);
		} else {
			const at = this.idlers.indexOf(runner);
			if (at >= 0) this.idlers.splice(at, 1);
		}
		runner.idle = null;
	}

	/** the first cpu, in `runners` order, whose interrupt word is raised or whose deadline passed */
	private pickIdle(): Runner | null {
		const now = this.now();
		if (this.core) {
			const slot = this.core.core_pick(now);
			if (slot < 0) return null;
			const picked = this.slots[slot]!;
			picked.idle = null;
			return picked;
		}
		const list = this.idlers;
		if (!list.length) return null;
		const buffer = this.memory.buffer;
		if (this.wordsOf !== buffer) {
			this.words = new Int32Array(buffer);
			this.wordsOf = buffer;
		}
		const words = this.words;
		const next = this.soonest();
		const due = next !== null && next <= now;
		for (let i = 0; i < list.length; i++) {
			const runner = list[i]!;
			if (runner.halted) continue;
			const idle = runner.idle!;
			const at = idle.word >> 2;
			if (
				words[at] !== 0 ||
				words[at + 1] !== 0 ||
				(due && idle.deadline >= 0n && idle.deadline <= now)
			) {
				list.splice(i, 1);
				runner.idle = null;
				return runner;
			}
		}
		return null;
	}

	private nextDeadline(): bigint | null {
		if (!this.core) return this.soonest();
		const deadline = this.core.core_deadline();
		return deadline < 0n ? null : deadline;
	}
	// #endregion

	/**
	 * Runs the machine until `until` says stop, or nothing can run and no timer is armed.
	 * `sleep(ms)` is how the host waits for a timer; `budget` caps pump steps for one call.
	 */
	async run(
		until: () => boolean,
		sleep: (ms: number) => Promise<void>,
		budget = Infinity
	): Promise<string> {
		if (this.spent)
			throw new Error('run: this machine checkpointed; continue from Machine.restore');
		this.running = true;
		try {
			return await this.pump(until, sleep, budget);
		} finally {
			this.running = false;
		}
	}

	private async pump(
		until: () => boolean,
		sleep: (ms: number) => Promise<void>,
		budget: number
	): Promise<string> {
		if (!this.cpuZero.instance) {
			this.instantiate(this.cpuZero);
			this.cpuZero.resume = () => void this.boot();
			this.ready.push(this.cpuZero);
		}
		let steps = 0;
		while (!until() && !this.halted && !this.crashed && steps++ < budget) {
			// idle cpus with a raised interrupt or a due timer go first, or a spinner starves them
			if (steps % (this.options.yieldEvery ?? 2000) === 0) await sleep(0);
			this.clock = this.now() + (this.options.stepNs ?? 50_000n);
			let next = this.pickIdle();
			if (next) next.idle = null;
			else next = this.ready.shift() ?? null;
			if (!next) {
				const deadline = this.nextDeadline();
				if (deadline === null) return 'deadlock: nothing runnable and no timer armed';
				const ms = Number((deadline - this.now()) / 1000000n);
				await sleep(Math.max(0, ms));
				// an idle machine that waited for its next timer has reached it, whether or not the host
				// clock moved meanwhile (a deployed Worker's stands still while code runs)
				if (this.clock < deadline) this.clock = deadline;
				continue;
			}
			const resume = next.resume;
			if (!resume) continue;
			if (this.options.trace)
				this.log(`resume ${next.name} value=${next.value} ready=${this.ready.length}`);
			next.resume = null;
			next.fail = null;
			this.current = next;
			// a rewinding stack re-enters the kernel exactly where it parked; nothing may come between
			if (this.route)
				this.route.value = next.rewinding
					? ROUTE_KERNEL
					: this.pendingFiles || this.applying
						? ROUTE_HOOK
						: this.idleRoute();
			if (next.saved) {
				this.taskGlobals.forEach((g, i) => (g.value = next.saved![i]));
				next.saved = null;
			}
			if (next.tag && this.deferred.has(next.tag)) await this.fillDeferred(next.tag);
			if (next.shared && next.sharedSaved) {
				next.shared.globals.forEach((g, i) => (g.value = next.sharedSaved![i]));
				next.sharedSaved = null;
			}
			const parked = new Promise<Runner>((r) => (this.suspended = r));
			resume(next.value);
			await parked;
			this.current = null;
		}
		if (this.crashed) return 'crashed';
		if (this.halted) return 'halted';
		return until() ? 'until' : 'budget';
	}
}
