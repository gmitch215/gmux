import { DlProcess, type DlSaved, type DlView } from './dl.ts';

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
	/** precompiled user programs keyed by the hex SHA-256 of their bytes */
	registry: Map<string, WebAssembly.Module>;
	/**
	 * a program made shareable by scripts/wasm/share.py runs every process on one instance, its
	 * bases, stack pointer and globals swapped at each switch (needs `sharedKernel`; no checkpoints)
	 */
	shareInstances?: boolean;
	/**
	 * builds of the registry's programs that check every store against the kernel's page owner
	 * table (scripts/wasm/guard-pass.py), by the same hash. A task whose effective uid is not 0 runs
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
	 * called on a software-TLB miss for a page of a program built with scripts/wasm/mmu-pass.py; a
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
	/** pump steps between macrotask yields, so a frozen host clock can advance */
	yieldEvery?: number;
	/** how far the kernel's clock moves per scheduling decision when the host clock does not */
	stepNs?: bigint;
	/**
	 * one vmlinux instance for every task, switching the task's mutable globals at each park and
	 * resume; needs a vmlinux that exports them (scripts/export-globals.py)
	 */
	sharedKernel?: boolean;
	/**
	 * the kernel and user modules are asyncified at their park imports (scripts/build-async.sh), so
	 * `checkpoint()` can turn every parked stack into bytes and `Machine.restore()` can rewind it
	 */
	asyncify?: boolean;
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

/** built by experiments/evacuation/scripts/evacuate.mjs --resume: checkpoints without asyncify */
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
	/** the kernel clock at checkpoint, in nanoseconds as a decimal string */
	now: string;
	/** console input not yet read */
	input: number[];
	/** tasks ready to run, in order, by id */
	ready: number[];
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
const RLIMIT_STACK = 3;
// a split stack grows by this much at a time (scripts/wasm/stack-pass.py)
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
	/** the parent's exported mutable globals (scripts/wasm/export-globals.py) */
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

interface Runner {
	name: string;
	instance: WebAssembly.Instance | null;
	/** how to continue this runner when the pump picks it */
	resume: Resume | null;
	/** the value handed to `resume` */
	value: number;
	idle: { word: number; deadline: bigint } | null;
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
		/** the stack's segments in stack order (scripts/wasm/stack-pass.py), the first where the kernel put it */
		segments?: { low: number; high: number }[];
		/** the segment the stack pointer is in */
		segment?: number;
		/** its dlopen'ed side modules */
		dl?: DlView;
	} | null;
	/** task globals saved at park, with a shared kernel instance */
	saved: number[] | null;
	id: number;
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
	/** its frames are spilling for a fork */
	forking?: boolean;
	/** what the re-issued __gmux_fork of its resumed frames returns: the child's pid, or 0 in the child */
	forkResult?: number;
	/** the stack pointer its fork was called with */
	forkSp?: number;
	/** the fork this runner is the child of, until its frames resume */
	forkOf?: Fork | null;
	/** signal handlers running on stacks of their own */
	handlers: number;
	/** inside a kernel entry of userInterrupt's, whose JS frame a checkpoint cannot carry */
	interrupting?: boolean;
	/** the handler a checkpoint unwound, or a restore has yet to rewind */
	signal?: HandlerStacks | null;
}

/** the function table a program needs (scripts/wasm/table-note.py), or 4096 without the note */
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

/** the registry key an exec stub carries (scripts/wasm/exec-stubs.py), or null for a full file */
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

class Trap extends Error {
	readonly kind: string;
	constructor(kind: string) {
		super(`host trap ${kind}`);
		this.kind = kind;
	}
}

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
	/** software-TLB misses in programs built with scripts/wasm/mmu-pass.py */
	mmuMisses: number;
	/** misses that parked a task until the host brought its page in */
	pageFaults: number;
	/** stack segments mapped for split stacks */
	stackSegments: number;
	/** forks through __gmux_fork */
	forks: number;
	/** pages a lazy restore left out */
	deferredPages: number;
	/** deferred pages brought in since */
	filledPages: number;
	/** processes that joined a shared program instance instead of instantiating */
	sharedEntries: number;
	/** the console driver's reads from the host */
	consoleReads: number;
	/** input interrupts raised to the console */
	consoleRaises: number;
	/** executables the registry did not hold, by hash and size */
	unknownExecutables: string[];
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
		deferredPages: 0,
		filledPages: 0,
		sharedEntries: 0,
		consoleReads: 0,
		consoleRaises: 0,
		unknownExecutables: []
	};
	/** whether the kernel halted (`reboot`, `poweroff`) */
	halted = false;
	/** the error that stopped the machine, if one did */
	crashed: unknown = null;

	private readonly options: MachineOptions;
	private running = false;
	// its stacks are bytes in a snapshot; only Machine.restore continues it
	private spent = false;
	private clockOffset = 0n;
	private scratch = 0;
	private unwound: (() => void) | null = null;

	/**
	 * a machine that has not booted; `run` boots it. Its memory starts at `initialPages` 64 KiB
	 * pages
	 */
	constructor(options: MachineOptions, initialPages = 15) {
		this.options = options;
		// the kernel's static memory, recorded at build time (scripts/wasm/memory-note.py)
		const note = WebAssembly.Module.customSections(options.vmlinux, 'gmux.memory')[0];
		const kernelPages = note ? new DataView(note).getUint32(0, true) : 0;
		const initial = Math.max(initialPages, kernelPages);
		if (options.memory && options.memory.buffer.byteLength <= initial * 0x10000) {
			this.memory = options.memory;
			const pages = this.memory.buffer.byteLength / 0x10000;
			if (pages < initial) this.memory.grow(initial - pages);
			new Uint8Array(this.memory.buffer).fill(0);
		} else
			this.memory = new WebAssembly.Memory({
				initial,
				maximum: options.maximumPages ?? 2048,
				shared: true
			});
		this.cpuZero = this.runner('cpu0', { kind: 'boot' });
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
				if (me.kill) self.release(prev);
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
				me.idle = { word, deadline: timeout < 0n ? -1n : self.now() + timeout };
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
				const user = new Uint8Array(mem.buffer);
				if (mem === self.memory || u + len > user.length) return len;
				if (mode === 0)
					new Uint8Array(self.memory.buffer).set(user.subarray(u, u + len), k);
				else if (mode === 1) user.set(new Uint8Array(self.memory.buffer, k, len), u);
				else user.fill(0, u, u + len);
				return 0;
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
				if (mem === self.memory || u & 3 || u + 4 > mem.buffer.byteLength) return -14;
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
			}
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
		return { module, hash, dataStart, tableStart };
	}

	private release(dead: number) {
		if (this.options.trace) this.log(`release ${dead} ${this.runners.get(dead)?.name}`);
		const runner = this.runners.get(dead);
		if (!runner) return;
		if (runner === this.current) runner.kill = true;
		else this.runners.delete(dead);
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
		const dl = this.dlProcess(user.dataStart).view();
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
			// scripts/wasm/guard-pass.py: stores checked against the kernel's page owner table
			const kernel = this.exp(runner);
			const fixed = (value: number) =>
				new WebAssembly.Global({ value: 'i32', mutable: false }, value);
			imports.gmux = {
				...imports.gmux,
				table: fixed(Number(kernel.wasm_owner_table())),
				tag: fixed(Number(kernel.wasm_current_owner()))
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
			// scripts/wasm/stack-pass.py: a frame allocation left its stack segment
			__gmux_stack_move: (sp: number) =>
				this.stackMove(this.shared ? this.current! : runner, sp),
			// fuel ran out in a user loop: give the other cpus the host thread, then refill
			__gmux_fuel: new WebAssembly.Suspending(() => {
				// a vfork child runs this instance as another task
				const me = this.shared ? this.current! : runner;
				if (me.rewinding) return this.rewound(me);
				this.stats.fuelYields++;
				me.value = this.options.fuelBudget ?? 200000;
				this.ready.push(me);
				return this.park(me, 'user').then((value) => this.userInterrupt(me, value));
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
		for (let n = 0; n <= 6; n++) env[`__wasm_syscall_${n}`] = kernel[`wasm_syscall_${n}`];
		return env;
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
	 * limits a program's stack pointer to the mapping it is in (scripts/wasm/stack-pass.py), as a guard
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
	 * split stacks (scripts/wasm/stack-pass.py): a frame allocation left its segment. The segments form
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
		// a new process image: nothing loaded at this data start belongs to it
		if (!clone) this.dls.delete(runner.user!.dataStart);
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
	 * experiments/evacuation/scripts/evacuate.mjs --resume) and forkUnwound forks the task; the
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

	/** a mapping of the process's own for its spilled frames, made once and reused while it lasts */
	private forkSpill(me: Runner): number {
		const kernel = this.exp(me);
		const mm = Number(kernel.wasm_current_mm()) >>> 0;
		const known = this.forkSpills.get(mm);
		if (known && kernel.wasm_user_stack_low(known) >>> 0 === known) return known;
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
	 * program unwinds with it; an evacuable one (experiments/evacuation/scripts/evacuate.mjs)
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
	/** shared instances, by program hash */
	private sharedPrograms = new Map<string, SharedProgram>();
	/** pages a lazy restore has not written yet, by owner tag, and where they come from */
	private deferred = new Map<number, number[]>();
	private deferredSource:
		((start: number, end: number) => Uint8Array | Promise<Uint8Array>) | null = null;

	/** writes a process's deferred pages before any of its tasks runs again */
	private async fillDeferred(tag: number) {
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

	/** fork children's own memories, by the kernel's mm (kernel patch 0015) */
	private privateMemories = new Map<number, WebAssembly.Memory>();
	/** forks whose child task has not started yet, by the child's mm */
	private forkChildren = new Map<number, Fork>();
	/** the fork in the middle of its clone, whose child's mm takes it */
	private pendingFork: Fork | null = null;
	/** each process's spill mapping for fork frames, by mm */
	private forkSpills = new Map<number, number>();

	/** the memory a task's program runs on: its own after a fork, else the machine's */
	private userMemory(runner: Runner): WebAssembly.Memory {
		if (!this.privateMemories.size) return this.memory;
		const mm = Number(this.exp(runner).wasm_current_mm?.() ?? 0) >>> 0;
		return this.privateMemories.get(mm) ?? this.memory;
	}

	private dlProcess(dataStart: number): DlProcess {
		let dl = this.dls.get(dataStart);
		if (!dl) {
			dl = new DlProcess(this.memory, this.options.registry, this.options.sha256, dataStart);
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
		// ponytail: a fork child's own memory is not in the snapshot yet
		if (this.privateMemories.size)
			throw new Error('checkpoint: fork children with their own memory are not saved yet');
		// ponytail: shared instances hold one process's values at a time; saving each runner's
		// set and rebuilding the template on restore would lift this
		if (this.sharedPrograms.size)
			throw new Error('checkpoint: shared program instances are not saved yet');
		if (!this.options.asyncify || !this.shared)
			throw new Error('checkpoint needs asyncify and a shared kernel');
		if (this.running) throw new Error('checkpoint while the pump runs');
		if ([...this.runners.values()].some((r) => r.vfork || r.vforkOf))
			throw new Error('checkpoint during vfork');
		// ponytail: one handler per task, from a syscall's return; nested handlers would stack HandlerStacks
		if (
			[...this.runners.values()].some(
				(r) =>
					r.handlers > 1 ||
					(r.handlers && (r.interrupting || !r.program || !evacuable(r.program.exports)))
			)
		)
			throw new Error(
				'checkpoint during a nested, interrupt-time or asyncified signal handler'
			);
		this.ensureScratch();
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
		for (const runner of this.runners.values()) {
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
		for (const runner of this.runners.values()) {
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
		const runners: SavedRunner[] = [...this.runners.values()].map((r) => ({
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
			signal: r.signal ?? null
		}));
		this.spent = true;
		return {
			version: 1,
			memory: new Uint8Array(this.memory.buffer),
			scratch: this.scratch,
			now: String(now),
			input: [...this.input],
			ready: this.ready.map((r) => r.id),
			cpuZero: this.cpuZero.id,
			runners,
			stats: { ...this.stats, unknownExecutables: [...this.stats.unknownExecutables] },
			dl: [...this.dls.values()]
				.filter((d) => d.libs.length || d.slots.length)
				.map((d) => d.save()),
			owners
		};
	}

	/**
	 * rebuilds a machine from a snapshot in fresh instances and rewinds every stack into its park.
	 * `image`, when given, writes the memory straight into the machine instead of snapshot.memory, so
	 * a large machine never needs a second full copy of itself to restore
	 */
	static async restore(
		options: MachineOptions,
		snapshot: Snapshot,
		image?: { byteLength: number; write(into: Uint8Array): void },
		lazy?: {
			byteLength: number;
			read(start: number, end: number): Uint8Array | Promise<Uint8Array>;
		}
	): Promise<Machine> {
		const machine = new Machine(
			options,
			(image ?? lazy ?? snapshot.memory).byteLength / 0x10000
		);
		const into = new Uint8Array(machine.memory.buffer);
		// a lazy restore writes the kernel's, free and shared pages now, and each parked process's
		// own pages when one of its tasks is about to run
		const owners = lazy && snapshot.owners;
		const tags = new Set(
			owners ? snapshot.runners.map((r) => r.tag ?? 0).filter((t) => t > 0 && t < 0xfffe) : []
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
		} else if (image) image.write(into);
		else into.set(snapshot.memory);
		const behind = BigInt(snapshot.now) - machine.now();
		if (behind > 0n) machine.clockOffset = behind;
		Object.assign(machine.stats, snapshot.stats);
		machine.stats.deferredPages = [...machine.deferred.values()].reduce(
			(n, l) => n + l.length,
			0
		);
		machine.stats.filledPages = 0;
		machine.input = [...snapshot.input];
		machine.scratch = snapshot.scratch;
		machine.instantiate(machine.cpuZero);
		for (const saved of snapshot.dl ?? []) machine.dlProcess(saved.dataStart).load(saved);
		const now = machine.now();
		for (const saved of snapshot.runners) {
			const runner =
				saved.id === snapshot.cpuZero
					? machine.cpuZero
					: machine.runner(saved.name, saved.entry);
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
			machine.runners.set(saved.id, runner);
		}
		for (const saved of snapshot.runners) {
			const runner = machine.runners.get(saved.id)!;
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
		machine.ready.push(...snapshot.ready.map((id) => machine.runners.get(id)!).filter(Boolean));
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

	/** the interrupt cpu's pending-interrupt word, once it has idled */
	private irqWord: number | null = null;

	/** an idle cpu whose interrupt word is raised; with `timers`, also one whose deadline passed */
	private pickIdle(timers: boolean): Runner | null {
		const words = new BigInt64Array(this.memory.buffer);
		const now = timers ? this.now() : 0n;
		for (const runner of this.runners.values()) {
			if (!runner.idle || runner.halted) continue;
			if (words[runner.idle.word / 8] !== 0n) return runner;
			if (timers && runner.idle.deadline >= 0n && runner.idle.deadline <= now) return runner;
		}
		return null;
	}

	private nextDeadline(): bigint | null {
		let soonest: bigint | null = null;
		for (const runner of this.runners.values()) {
			if (
				runner.idle &&
				runner.idle.deadline >= 0n &&
				(soonest === null || runner.idle.deadline < soonest)
			) {
				soonest = runner.idle.deadline;
			}
		}
		return soonest;
	}

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
			let next = this.pickIdle(true);
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
