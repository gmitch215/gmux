# Technical Report: Linux on Cloudflare Workers

gmux runs a real Linux kernel, compiled to WebAssembly, inside one Cloudflare Worker deployment. Each
machine is a Durable Object; its kernel, BusyBox and user programs share one linear memory and one
host thread. This document is the engineering reference for that system: how it is put together,
which platform limits shape it, what each operation costs, and which classes of defect it has
produced.

`src/` holds the machine host, the site Worker, Katybug, gmux's C runtime and the kernel, musl and
BusyBox patches; `experiments/` holds one probe per measurement, deployed to a Free account and torn
down after each run. Every figure is measured, and the instrument is named beside it, because a local
wall clock and a deployed `cpuTime` reading are not interchangeable.

---

## 🧭 Executive Summary

Linux 7.0 (the `joelseverin/linux` wasm fork) boots to a BusyBox shell inside a Free-plan Durable
Object, runs pipelines and background jobs, and finishes a job that needs more CPU than one event
allows. Blocking is JSPI; checkpointing is Asyncify for the kernel, and either Asyncify or resumable
frames for user programs, paid only when a machine leaves memory.

| | measured | instrument |
| --- | --- | --- |
| Terminal at `/_gmux/term`, deployed | claim once (second claim 409), bad token refused, prompt in **1.4 s**, shell answers | `src/site-do.ts`, Free |
| Boot to a shell prompt | **476 ms** median (n=31, 299-799) at 31-175 MiB machines | edge `cpuTime`, `experiments/boot` |
| Park plus resume of a task across two instances | **~1.3 us** (`(131 - 4) ms / 100,000`) | edge `cpuTime`, `experiments/jspi-parks` |
| Longest job finished across events | **1 GiB** `yes \| head \| sha256sum`, 5 events, exact | output against native |
| Longest job finished in one event | 256 MiB of the same, **10.0 s** of CPU, exact | edge `cpuTime` |
| Object memory budget | **~195 MiB** retained, shared by linear memory, instances and stacks | ramp to reset, keep-alive client |
| One kernel instance | **~2.7 MiB** of that budget | 80 held reset, 70 kept |
| Checkpoint, 64 MiB, 5% dirty | **7 ms**, 2 rows, 2.8 MB | edge `cpuTime`, rows counted |
| Full checkpoint, 64 MiB | **301 ms**, 34 rows; restore 112 ms | edge `cpuTime` |
| Forced eviction then restore of parked tasks | **8 of 8** exact | `ctx.abort()`, `experiments/machine-checkpoint` |
| Whole booted machine checkpointed mid-job, evicted, restored | **exact**, 1 GiB foreground 3 of 3, background job 2 of 2, idle 4 of 4 | `ctx.abort()`, Free |
| Pipes, job control, `^C`, background jobs | **5 of 5** cases | `experiments/shell`, Free |
| `vfork`, `$(...)`, pthreads, a signal handler that blocks, the POSIX surface | **all pass** (execve, `_exit`, failed execve; 4 threads x 10,000 locked increments; sockets, flock, epoll, eventfd, timerfd, inotify) | `experiments/vfork`, `posix`, Free |
| Lua 5.4.7's own suite, file by file | **25 of 32** on Free at 150 MiB, 28 of 32 in Node at 256 MiB, against **29 of 32** native musl | `experiments/setjmp`, Alpine reference on paisley-park |
| Checkpoint of the whole booted machine, mid-pipeline | **18-53 ms**, 73 stacks in 17.3 KB; restore 19-52 ms; 11 of 11 exact | local wall clock, Node |
| Asyncify tax on a CPU pipeline | **+63%**, almost all in the user program; kernel +3-9% | local wall clock, Node, interleaved |
| Native wasm compiled at startup from compressed bytes | **54.5 MB** in 715 ms; 15 copies rejected | wrangler `Worker Startup Time` |
| Package census | **15 programs and 7 libraries** of 48 recipes build and link cleanly | `scripts/census.sh`, paisley-park |
| Unchanged amd64 BusyBox, coreutils, bash, sqlite3 and curl under Katybug | **117 of 117** transcript lines equal native x86-64 Linux, inside a machine; 31,725-case instruction corpus equal | `tests/c/katybug/`, paisley-park reference |
| `fork` from an unmodified C program | **5 of 5** cases, including a forking server whose handlers fork again; deployed | `tests/c/fork.c`, Free |

### What Decides the Design

**Task count, not CPU, was the ceiling on a running machine.** linux-wasm gives every task its own
vmlinux instance. Boot alone creates 48, each instance holds ~2.7 MiB of the object's budget, and a
machine died silently after about ten more processes in its lifetime: event outcome `ok`, no
exception, a new instance on the next request. vmlinux has five mutable globals, so gmux runs every
task on one instance and swaps those five words at each switch. After that change the 1 GiB job ran
across five events on one instance. See One Kernel Instance for Every Task.

**The object budget is one number, and everything draws on it.** A single `WebAssembly.Memory`
stops at 128 MiB; retained memory of every kind resets the object near 195 MiB. Parked JSPI stacks
are charged, ~10-14 KiB each at 1,025 frames, which an earlier survival test misread as free.

**Warm state lives only while the object is resident.** A standard WebSocket keeps an object and its
parked stacks resident past 30 minutes idle. The hibernation API and alarms lose them between 5 and
15 s. A deploy restarts every resident object. So a machine that must survive idleness, eviction or
publication has to reach a checkpoint first. The checkpoint path is JSPI park, then Asyncify unwind
into linear memory, then packed dirty pages in SQLite. It restores a booted kernel with a pipeline
mid-run exactly under Node; the deployed run is next.

**Checkpointing costs user programs, not the kernel.** Asyncifying BusyBox adds 63% to a CPU-bound
pipeline; asyncifying the kernel adds 3-9% to the same job and 35% to boot. A process only needs the
instrumentation if it must survive a checkpoint mid-computation, so the next design compiles both
variants of a program at startup and chooses per process.

**Free meters that bind:**

| meter | free | what spends it |
| --- | --- | --- |
| CPU per event | 30 s, reset per message or request | invocation quanta end at 5-10 s |
| Subrequests per event | 50, shared by `fetch`, `connect` and `ASSETS.fetch` | chunk loads, sockets |
| Rows written | 100,000 per day, account-wide | checkpoints (twice the rows stored), the overlay |
| DO duration | 13,000 GB-s per day | residency; a warm machine costs ~11,059 GB-s a day |

### What Is Not Yet Measured

Root processes share one trust domain, and non-root processes are isolated for writes only: they
can still read the kernel's and other processes' memory (`SECURITY.md`). A forked child copies its
parent's memory eagerly and cannot share memory with other processes. Also unmeasured: any serving
workload, execution memoization, publication of proven responses, energy, and a deployed run of the
latest kernel (console interrupt, scheduler clock, exec stubs). None of it has a number, and no
figure here stands in for one.

---

## Architecture

### The Machine Is a Durable Object

A machine is one Durable Object id. Its constructor holds no state beyond what SQLite restores; the
kernel, its tasks and the console live in the object's memory while it is resident. One Worker
deployment serves the front door, the Durable Object class and the Static Assets that carry the root
filesystem and the terminal.

The kernel and every process share one `WebAssembly.Memory`. Each user program is its own wasm
instance importing that memory, `__memory_base`, `__table_base`, `__stack_pointer`, a table, and
`__wasm_syscall_0..6` directly from the kernel instance, so a syscall is a wasm-to-wasm call with no
JavaScript frame. One machine is one trust domain: no process is isolated from another by wasm.

### One Host Thread, Suspended by JSPI

linux-wasm's browser host backs each task with a Web Worker and blocks it in `Atomics.wait`. A
Durable Object has one thread and refuses `Atomics.wait`. Every blocking host import is instead a
`WebAssembly.Suspending` function, every entry into a task goes through `WebAssembly.promising`, and a
pump in `experiments/boot/src/machine.ts` resumes exactly one task at a time by resolving the promise of
the task the kernel names next.

| host import | what it does under the pump |
| --- | --- |
| `wasm_serialize_tasks(prev, next)` | queues `next`, parks the caller |
| `wasm_create_and_run_task(...)` | starts a task at `ret_from_fork`, parks the caller |
| `wasm_idle_wait(word, timeout)` | parks an idle CPU until its interrupt word is raised or its deadline passes |
| `wasm_cpu_relax()` | re-queues the caller behind the ready queue |
| `wasm_load_executable(...)` | looks the binary up by SHA-256 in a registry of precompiled modules |
| `__gmux_fuel()` | a user loop ran out of fuel: re-queue, refill, park |

Idle CPUs with a raised interrupt word or a due timer run before the ready queue, because a spinning
CPU otherwise starves the one that would deliver its wakeup. The pump yields a macrotask every 2,000
steps.

**The kernel clock steps when the host clock stands still.** A deployed Worker's `Date.now()` does
not advance while code runs, so every reading inside one event returned the same time. With the
kernel's clock frozen, a shell running a background job corrupted its own heap and `^C` could not stop
a busy loop, on the plain and the asyncified kernel alike. When the host clock has not moved since the
last reading, each pump step now advances the kernel clock by `stepNs` (default 50 us), and the clock
never goes backwards. A unit test runs the toy kernel with the host clock pinned at zero and fails
when the step is zero. The same failure reproduces offline under Node with a frozen clock.

### One Kernel Instance for Every Task

vmlinux's mutable state per task is five globals: `__stack_pointer`, `__tls_base`, `current`,
`__user_stack_pointer` and `__user_tls_base` (indices 0, 1, 4, 5 and 6). Everything else a task owns
is in linear memory. `scripts/wasm/export-globals.py` exports the five as `gmux_*`, and the
host's `sharedKernel` mode saves them when a task parks and restores them before it resumes. A new
task starts from the values a fresh instance would have.

| | per-task instances | one shared instance |
| --- | --- | --- |
| Instances after boot | 48 (37 at `maxcpus=1`) | 1 |
| Node heap after boot and a job | 47.4 MB (a 3-process pipeline) | 23.5 MB (two pipelines and 8 more processes) |
| Node RSS, same runs | 171.9 MB | 96.3 MB |
| Deployed: processes before the object resets | ~10 in its lifetime | none reset: 16 in one event; a 3-stage pipe in each of 6 events |

User programs still need one instance each, because `__memory_base` and `__table_base` are immutable
and differ per process. A BusyBox instance costs ~1.9 MiB, so the governor bounds live processes.

### Fuel Safepoints

A build-time pass (`scripts/wasm/fuel-pass.py`, prototype) decrements a counter at loop
heads and calls the suspending `__gmux_fuel` import at zero. It preempts a `while true` loop without
losing the shell. Fuel is not a clock: iterations per CPU-ms span 90x across loop shapes (Measured
Costs), so the scheduler reads the host clock at each safepoint and ends an event on the clock. The
target quantum is 5-10 s against the 30 s limit.

### Invocation Quanta

A Durable Object event gets 30 s of CPU, and the next incoming message or request resets it. Work
longer than that parks at a safepoint, returns from the event, and resumes on the next one while the
object stays resident. On a relocated object, one JSPI continuation ran 45 s of CPU across six
standard-socket messages on one instance, and a 9 s version matched a single-pass reference byte for
byte. On the booted kernel, a 1 GiB pipeline ran across one exec event and four run events of 5.8-6.8 s
wall each.

### Checkpoints

A parked task's stack is opaque to the host. To checkpoint, the host wakes the park with "unwind",
starts Asyncify's unwind inside the resumed host call, and the whole stack (process frames and kernel
frames) lands in linear memory. Restore rewinds into fresh instances and stops at the innermost import,
back in its JSPI park. Warm switching never pays for this; the Asyncify instrumentation tax is paid on
the calls it instruments.

On the booted kernel, `Machine.checkpoint()` in `experiments/boot/src/machine.ts` does this for every
task. The kernel and BusyBox are asyncified at their park imports (`scripts/build-async.sh`), and all
tasks share one kernel instance, so a checkpoint unwinds one stack at a time through a 2 MiB scratch
region and copies each out. The snapshot carries linear memory and each stack, plus host state:

| state | why |
| --- | --- |
| the five task globals per task | a shared instance holds only the running task's |
| every mutable global of each process instance, exported as `gmux_g*` | a fresh process instance starts from initial values |
| idle deadlines as time remaining | the host clock moves between isolates |
| the ready queue, per-task resume values, console input | the scheduler lives in JavaScript |

`Machine.restore()` instantiates fresh modules over the saved memory, and neither start function
changes a byte of it. It then rewinds each task into the import it parked in, which parks it again.
A machine that checkpointed cannot keep running; it continues from a restore.

A program can carry resumable frames instead of Asyncify
(`experiments/evacuation/scripts/evacuate.mjs --resume`). A call that can reach a syscall is
wrapped so a checkpoint spills the frame's live locals, and each such function gets a variant
that reloads them and continues from that call; only the kernel stays asyncified. A side module
loaded with `dlopen` imports the program's unwind state and shares one resume table with it, so a
stack that runs program, then library, then program again resumes too.
`experiments/evacuation/scripts/control-flow.ts` checkpoints recursion, function pointers,
`setjmp`/`longjmp`, a `qsort` callback, a signal handler, a side module calling back by pointer and
by import, and Lua inside `pcall` inside a coroutine; the harness refuses a checkpoint that lands
outside the phase it tests, and each restore is exact. Against the plain build, the wrapped calls
cost 0.977-1.023x on six census programs.

Changed pages are found at checkpoint time by hashing each 64 KiB page, packed with a small page index
into rows of up to 2 MB, and written only after `ctx.storage.sync()` succeeds. There is no store
barrier (Dirty Tracking, below).

### Two Sockets per Terminal

A WebSocket cannot change API mode after it is accepted. A terminal holds a hibernatable control
socket for its session and, while the machine holds opaque continuations, a standard warm-lease
socket that keeps the object resident. At quiescence the machine checkpoints and closes the lease;
the control socket survives eviction, and its next message wakes a new instance that restores.

### The Terminal

`src/site.ts` serves the terminal page from Static Assets at `/_gmux/term` and routes `/_gmux/*` to
the machine's Durable Object, `src/site-do.ts`. The first visitor claims the machine with `POST
/_gmux/claim` and receives an owner token once; the object stores only its SHA-256
(`src/worker/owner.ts`). Both sockets require the token. The control socket is hibernatable and
carries console bytes. The warm socket is standard, keeps the object resident, and sends a tick
each second that gives the machine a 5 s quantum; a keystroke gives it 250 ms. A hidden page closes
its warm socket. Until the deployed checkpoint works, a machine evicted after its last warm socket
closes boots again on the next keystroke; on Free, a control socket idle for 70 s saw the object
evicted, and the next keystroke booted a fresh machine and got an answer. All sessions share the one
console.

### Executables

A Worker refuses `WebAssembly.compile` at request time. linux-wasm's `wasm_load_executable` compiles
bytes read from the kernel's filesystem, so gmux resolves every `execve` through a registry keyed by
SHA-256 of modules compiled at deploy or at isolate startup. Module scope may compile any bytes present
in the deployment, including decompressed ones: one 1.66 MB gzip blob becomes vmlinux plus BusyBox,
compiled natively, at startup.

Since the host already holds every module, the rootfs does not need the code. The build replaces each
wasm executable in the initramfs with a stub (`scripts/wasm/exec-stubs.py`): the header, the
`dylink.0` section that `binfmt_wasm` reads for memory and table sizes, and a `gmux.exec` section
holding the SHA-256 of the full file. The host takes the hash from the stub and hashes only files
without one. The registry is the set of programs any user can run: a stub names a module without
carrying it, so the registry must hold nothing a user may not execute. An executable the registry
does not hold fails its `execve` past the point of no return, so the process ends with `SIGSEGV`
(status 139 in the shell) and the machine keeps running.

| rootfs (Node, 3 rounds)                  | full files          | stubs               |
| ---------------------------------------- | ------------------- | ------------------- |
| initramfs, gzip / raw                    | 750,452 / 1,836,032 | 5,290 / 61,116      |
| page cache after boot                    | 3,340 KiB           | 1,600 KiB           |
| MemFree after boot, 64 MiB machine       | 45,948-46,008 KiB   | 47,012 KiB          |
| 300 fork+exec of `/bin/busybox true`     | 568-828 ms          | 152-243 ms          |
| memory image: non-zero 4 KiB pages, gzip | 4,054-4,122, 3.1 MB | 3,841, 2.0 MB       |

Execs got faster because the host no longer copies and hashes 1.45 MB twice per iteration (fork
and exec each look the program up). MemFree gains less than the page cache drops because a
full-file initramfs hands its 732 KiB back to the kernel after unpacking.

### Foreign Executables

Katybug (`src/gmux/katybug/`) runs x86-64 and AArch64 Linux ELFs inside the machine: `binfmt_misc`
hands a foreign ELF to `/bin/katybug`, which decodes basic blocks into the gmux IR and interprets
them, turning guest syscalls into the machine's own. Guest addresses are 64-bit and live in
mappings, each backed by one host block, so a guest can map above 4 GiB (PIE at
`0x555555554000`, the stack below `0x7ffffff00000`, `mmap` from `0x100000000000`) while the machine
stays wasm32.

Each load and store in a decoded block keeps an inline cache of the last mapping it hit: its range,
its host block and a generation. Every change to the mappings (`mmap`, `munmap`, `mprotect`, `brk`)
bumps the generation, which stales every cache at once. Only a mapping that nothing newer overlaps
is cached, so a `MAP_FIXED` mapping or a hole always wins. On an amd64 `sqlite3` workload,
translation had been 29% of native samples, and the mapping search 22%; the cache cut the search to
about 2%.

| amd64 sqlite3, 60,000-row insert and group-by | per-access lookup | inline cache |
| --------------------------------------------- | ----------------- | ------------ |
| native katybug on the laptop                  | 6.59-6.86 s       | 4.83-4.84 s  |
| wasm katybug in the machine, steady rounds    | 10.04-10.06 s     | 5.92-5.97 s  |

The test for it (`tests/c/katybug/signals.c`: one load site through a mapping, a `MAP_FIXED`
remap and a `munmap`) found that `munmap` of the newest mapping uncovered an older one at the same
range, with its old data, where Linux faults. Running the transcript inside the machine then hit
`bts`, which Katybug had never decoded; curl reaches it only when a connect does not finish at
once, so it came and went with timing. `bts`, `btr` and `btc` now decode, and a register bit offset
into memory addresses a bit string as the hardware does.

Each decoded block then goes through a plan before it runs. The first plan is flag demand: a flag
write is dropped when every flag it sets is written again before anything reads it. The block's
exits, and every op that can fault, count as reading all flags, because a signal frame carries
rflags. `KATYBUG_PLAN=0` runs blocks as decoded, and `KATYBUG_STATS` reports what the plan
dropped. On the sqlite3 workload it drops 16% of the flag writes executed (13.0M of 80.5M), for
about 1%: dispatch dominates the interpreter's time, not flag arithmetic. The instruction corpus
is 31,725 cases, equal to native with the plan on and off; 360 of them put a partial flag writer,
a zero-count shift or a flag read between two full writers.

Against native x86-64 on the same host (paisley-park, Ryzen 9 9900X, `node:26` capped at 2 CPUs,
load under 1.6), the same static amd64 binaries run natively and through Katybug in a machine,
timed by the host between output markers, 3 rounds interleaved
(`experiments/katybug-profile/scripts/bench.ts`):

| workload | native | Katybug in gmux | r |
| --- | --- | --- | --- |
| `factor` of 20,001 13-digit numbers | 43 ms | 4,257-4,305 ms | 99 |
| BusyBox `gzip -9`, 2.6 MB | 58-68 ms | 9,151-9,210 ms | 154 |
| BusyBox `bzip2 -9`, 2.6 MB | 78-79 ms | 16,829-16,949 ms | 216 |
| `sqlite3`, recursive CTE to 100,000 | 15 ms | 4,093-4,167 ms | 275 |
| `bash`, 20,000-iteration arithmetic loop | 71-74 ms | 24,030-24,092 ms | 331 |
| coreutils `sha256sum`, 2.6 MB | 6-7 ms | 1,916-1,919 ms | 303 |
| `curl` of a 2.6 MB `file://` URL | 3 ms | 9 ms | 3 |

A CPU profile of the same runs (a build with the interpreter's helpers kept out of line,
`-DKB_PROFILE`, and V8's wasm inlining off, 100 us sampling) puts the time in the interpreter's
dispatch loop:

| workload | dispatch and execute | memory lookup | flags | block lookup | syscalls | decode |
| --- | --- | --- | --- | --- | --- | --- |
| factor | 78.7% | 7.1% | 5.8% | 2.9% | 2.0% | 0.0% |
| gzip | 71.5% | 15.5% | 7.5% | 2.5% | 2.1% | 0.0% |
| bzip2 | 63.8% | 25.2% | 5.0% | 2.6% | 1.9% | 0.0% |
| sqlite | 78.6% | 12.0% | 3.9% | 3.3% | 1.5% | 0.0% |
| bash | 75.9% | 13.0% | 3.8% | 4.8% | 1.5% | 0.0% |
| sha256 | 93.1% | 3.9% | 1.7% | 0.5% | 0.2% | 0.0% |

Dispatch and execute includes guest register traffic, since the interpreter keeps guest registers
in an array and the profile cannot separate the two. x87 and SSE stay under 1% on these programs;
the kernel and the host together under 1%. curl moves bytes through syscalls (64 samples) and
runs near native speed. A faster Katybug is a faster dispatch loop: fused blocks, guest registers
held in locals, or blocks translated to wasm.

Katybug also decodes wasm (`src/gmux/katybug/wasm.c`, `katybug --wasm <module> <export> [args]`), so
the IR has a third frontend and a planner over it sees native wasm programs too. Validated wasm has a
static operand-stack height at every instruction, so each local and stack slot is a fixed cell in the
function's frame, and every instruction becomes loads, IR ops and stores at constant offsets. A call's
arguments already sit where the callee's locals begin, and a return stack holds the return pc and the
caller's frame. The frontend covers the integer instructions, memory at every width, globals, block,
loop, if, br, br_if, br_table (with values carried), calls and call_indirect with their traps. Floats,
`memory.grow`, bulk memory and calls to imports trap as unsupported, so it runs functions, not yet
whole linux-wasm programs. The corpus (`tests/c/katybug/wasm-ops.sh`) runs 3,649 calls on 97
functions under V8 and under Katybug, edge values included; every line matches, and a Katybug with
one condition code wrong (`i32.lt_s`) fails 60 of them.

A foreign program can be checkpointed through Katybug. With Katybug built with resumable frames,
the control-flow matrix runs amd64 bash parked in `read` inside Katybug's interpreter, checkpoints
the machine, restores it into a fresh one and finishes the transcript unchanged, beside the seven
C phases and Lua (`experiments/evacuation/scripts/control-flow.ts` with `KATYBUG` and `BASH`).

---

## Platform Constraints

### Durable Object Memory

Measured on Free with a single keep-alive client at one request per second. An object that crosses the
limit returns its response normally and is replaced before the next one.

| holding | result |
| --- | --- |
| one unshared `Memory`, `initial` 128 MiB | allocated |
| one unshared `Memory`, `initial` 136 MiB or more | `RangeError: WebAssembly.Memory(): could not allocate memory` |
| 8 MiB memories, retained | reset right after 200 MiB (6 of 6 ramps) |
| one shared memory grown 8 MiB at a time | reset right after 193 MiB (5 of 5); 185 survives |
| vmlinux instances | 80 reset, 70 kept |
| vmlinux instances beside 97 MiB of linear memory | 45 reset, 40 kept |
| BusyBox instances | 100 reset, 90 kept |
| grow ramp after parking N stacks of 1,025 frames | N = 0, 1k, 2k: 193 MiB; 4k: HTTP 500 at 185; 6k, 8k: 113 |
| grow ramp after 20,000 stacks | 16 frames: 177 MiB; 256 frames: 73 MiB |

Parked tasks have a separate knee. With 16 frames each, 48,000 tasks parked and drained in 1.51 s of
CPU; 64,000 stopped progressing after 2.06 s and were cancelled at 120 s wall; 80,000 and 100,000
ended in an exception at ~64 s wall. That knee is narrowed, not attributed.

### First Placement

A new object whose CPU passes ~1 s is replaced after that event: new instance, memory and sockets
gone. 50 fresh objects at 05:12 EDT, CPU per object from `wrangler tail`:

| CPU of the burn | kept | replaced |
| --- | --- | --- |
| 301-758 ms | 20 | 1 (686 ms, the one outlier) |
| 782-980 ms | 13 | 0 |
| 1,017-1,611 ms | 0 | 16 |

The same threshold held in the first run at ~01:40 EDT (965 ms kept, 1,019 ms replaced). After that
first replacement the object ran 5 s and ~10 s events without another.

The threshold counts CPU across events, not within one. Five fresh objects each ran three burns of
589-723 ms: every one kept its instance after the first and was replaced after the second, at ~1.3 s
in total (`experiments/event-quanta/scripts/cumulative.mjs`). Keeping the first event short
therefore does not avoid the replacement; every object meets it once.

The site spends it before a machine exists (`src/worker/placement.ts`). A fresh object's first
request burns ~1.5 s of CPU, records which instance did so, and answers 503; the terminal retries.
The next request arrives on the replacement instance, which sees that another instance did the
burning and marks the object placed. Six fresh objects on Free went prime, then placed on the next
request, then kept their instance through a 1.5 s burn (`placed.mjs`; priming cost 1,459-1,819 ms).
A large program's startup can then pass a second of CPU without taking the machine with it.

### CPU per Event

The per-event kill sits between 25 and 35 s: ~25 s completed and ~35 s failed with `1101`, consistent
with the documented 30 s. Residency after the event depends on what holds the object:

| holder | 5 s | 10 s | 15 s | 60 s | 5 min | 30 min |
| --- | --- | --- | --- | --- | --- | --- |
| standard WebSocket (`accept`) | | kept | | kept | kept | kept |
| hibernation-API WebSocket | kept | | lost | lost | lost | |
| alarm, no connection | kept | | lost | lost | | |

With no connection, an object idle for 35 s was evicted every time (18 of 18).

### Subrequests

`fetch()`, `connect()` and `ASSETS.fetch()` share one cap of **50 per event** on Free. The 51st fails
with `Too many subrequests by single Worker invocation`, and the next event starts at zero again. An
asset fetch from a Durable Object is not under the 1,000-request internal limit. 50 sockets held open
at once worked.

### Publication

An asset-only deploy, run while machines were live:

| machine state at deploy | result |
| --- | --- |
| resident, parked tasks, warm and control sockets open | both sockets closed with 1006 ~7-12 s into the deploy; parked tasks lost (2 of 2) |
| resident, control socket only, 2 s after closing the warm one | control socket closed with 1006 (1 of 1) |
| evicted (control socket only, idle 60 s) | control socket kept; next message woke the new version with storage intact (2 of 2) |

Publishing therefore restarts every resident machine. The publisher quiesces first.

### Networking

`connect()` to Cloudflare addresses fails with `proxy request failed, cannot connect to the specified
address` (tried: example.com and cloudflare.com). To www.google.com, raw TCP on port 80 and
`secureTransport: "on"` on 443 both returned `HTTP/1.1 200 OK` in 90-172 ms. A real SMTP STARTTLS
exchange with smtp.gmail.com:587 read the banner, saw `STARTTLS` in EHLO, got `220 2.0.0 Ready to start
TLS`, upgraded with `startTls()`, and answered EHLO over TLS, in 133-206 ms. DNS over HTTPS through
`fetch()` returned 200 with A records.

### Codegen

| check, deployed on Free | result |
| --- | --- |
| `new WebAssembly.Module(bytes)` at module scope, 13.4 MB | compiles; startup 32 ms against 2 ms without |
| the same call at request time | `Wasm code generation disallowed by embedder` |
| a loop compiled at startup against the bundled import, n=6 | 332-382 ms against 343-525 ms, same result |

Module scope cannot do I/O, so the bytes must be in the deployment already; Static Assets arrive only
through an asynchronous fetch.

---

## Measured Costs

### Boot

Kernel boot to the BusyBox prompt: **299-799 ms** of `cpuTime`, median 476 (n=31, 31-175 MiB machines,
`maxcpus=3` except two at 1). Stripping vmlinux's 7,159 exports to the 17 the host uses cut the host's JS heap
from 135 to 35 MiB. Creating one vmlinux instance costs 1.2-1.4 ms of CPU (24-27 ms for 20), a
BusyBox instance ~2.5 ms including its data segments (48-55 ms for 20).

### Suspension

| arm | result |
| --- | --- |
| 4 tasks x 250 syscalls, 16 process frames above each park, n=5 | 1,000 parks and resumes exact, 7-14 ms |
| 0 / 100,000 / 1,000,000 cycles, n=3 each | 2-4 / 130-151 / 1,565-2,514 ms, all exact |
| a wasm3 guest calling a `Suspending` import | 1,000 and 100,000 cycles exact; two interleaved interpreters exact |
| 5,000 and 20,000 tasks parked at once, 1,025 frames | all resumed exact |

burrow's wasm3 suspends through a `Suspending`-wrapped `burrow.host_call` with no change to burrow.

### Checkpoints

64 MiB image: kernel and BusyBox bytes over three quarters, zero pages above, 5% of pages dirty, 2 MB
rows, `cpuTime` per operation:

| strategy | CPU | rows | bytes | restore CPU |
| --- | --- | --- | --- | --- |
| full image | 301 ms | 34 | 64 MiB | 112 ms |
| full image, deflated | 1,671 ms | 34 | 18.5 MB | 220 ms |
| dirty pages, packed | 7 ms | 2 | 2.8 MB | 4 ms |
| dirty pages, packed, deflated | 55 ms | 2 | 0.64 MB | 12 ms |

At 32 MiB the four cost 160, 720, 3 and 30 ms. On random bytes deflate gains nothing and costs more
(64 MiB: 2,238 ms). Deflate runs ~26 ms per MiB. Each checkpoint also deletes the rows it replaces,
so rows written are twice the rows stored. Compressing before packing would cut rows by the compression
ratio, 3.6:1 on this content.

The Asyncify handoff, on a probe of four tasks with 16 frames each: 8 of 8 exact after forced eviction;
~+15% on 100,000 syscall cycles (144-183 ms against 123-145, n=3); checkpoint 1-2 ms and restore 0-2
ms at a 128 KiB image. Whole-machine replay from a syscall log restored 13 of 15; the two losses did
not reproduce in 13 later runs and are unattributed, so replay is not a correctness mechanism yet.

The whole booted kernel, 64 MiB machine, local wall clock under Node:

| case | result | checkpoint | stacks | restore |
| --- | --- | --- | --- | --- |
| `yes \| head -c 100000000 \| sha256sum` in the background, mid-run | 5 of 5 exact; the shell answers after | 18-53 ms | 73 in 17.3 KB | 19-52 ms |
| idle shell at its prompt | 6 of 6 exact | 46-50 ms | 46 in 10.8 KB | ~50 ms |

Asyncify's cost on the same pipeline, n=2-3, arms interleaved:

| kernel | BusyBox | pipeline | boot |
| --- | --- | --- | --- |
| plain | plain | 2,383-2,407 ms | 88-95 ms |
| asyncified | plain | 2,458-2,632 ms | 117-121 ms |
| plain | asyncified | 3,912-3,921 ms | 98-100 ms |
| asyncified | asyncified | 3,889-3,976 ms | 117-133 ms |
| asyncified | asyncified, syscalls only (no fuel unwind) | 3,498-3,762 ms | 121-127 ms |

Asyncify grows vmlinux from 3,055,484 to 5,215,385 bytes and BusyBox from 1,399,087 to 3,304,116.

Deployed on Free, the persistence path works: a 50 MiB machine checkpoints into 27 rows of 2 MB plus
45.6 KB of metadata, `ctx.abort()` forces a new instance, and that instance rewinds all 70 runners.
In local workerd the whole cycle passes: a mid-pipeline checkpoint of 73 stacks into 27 rows,
`ctx.abort()`, a new instance, restore, and the exact checksum with the shell answering. That took one
fix. workerd does not run the continuation of an entry wrapper started by an earlier request, so a
checkpoint that waited for it hung. The unwind itself finishes inside microtasks, so the checkpoint
now completes it after one macrotask and ignores a late continuation.

On Free, after the clock fix, the whole cycle is exact: a 1 GiB foreground pipeline checkpointed
mid-run, aborted and restored, 3 of 3; a 100 MB background job checkpointed mid-run, 2 of 2 (73
runners, 27 rows, 48.9 KB of metadata); an idle shell, 4 of 4. Each restore ran on a new instance and
finished with the exact checksum and the shell answering.

The heap corruption first read as a defect in the asyncified kernel. It was the frozen clock (One Host
Thread, Suspended by JSPI). Attribution arms showed the plain kernel crashing too, and only with a background job.

### Dirty Tracking

| arm, deployed | cost |
| --- | --- |
| no barrier; SHA-256 each 64 KiB page at checkpoint | 57 ms per 32 MiB, 126 ms per 64 MiB |
| no barrier; JavaScript compare against a shadow copy | 98 / 187 ms, and twice the memory |
| page-bitmap first-write barrier on every store | 1e8 random stores over 32 MiB: median 3,583 ms against 2,490 plain (n=6), +44% |
| card marking, 512-byte cards, every store | median 3,326 ms, +34% |
| either barrier, 256 KiB working set | inside placement noise (plain 750-1,569 ms, n=5) |

Hashing at the checkpoint costs nothing between checkpoints. A barrier taxes every store of every
workload to save that work. The default is hashing.

### Fuel

1e8 loop-head iterations per shape, deployed:

| shape | CPU | iterations per ms |
| --- | --- | --- |
| ALU | 173 ms | 578,000 |
| call-heavy | 450 ms | 222,000 |
| branchy | 557 ms | 180,000 |
| pointer chase over 32 MiB | 15,596 ms | 6,400 |

At the host's default budget of 200,000 iterations, the distance between safepoints is 0.35-31 ms of
CPU across these shapes.

### Asset Fetches

`ASSETS.fetch()` from a Durable Object, n=5 per size:

| size | first fetch | repeats |
| --- | --- | --- |
| 1 KiB-1 MiB | 95-195 ms | ~0 ms |
| 4 MiB | 244 ms | 11-16 ms |
| 8 MiB | 207 ms | 23-33 ms |
| 16 MiB | 458 ms | 41-79 ms |

CPU is ~0.8 ms per MiB (five 16 MiB fetches: 64 ms). With 50 fetches per event, shared with sockets,
1-4 MiB chunks with read-ahead fit the budget; a 16 MiB chunk spends a twelfth of the object's memory
to serve one 4 KiB page.

### Startup Compile

One 1.66 MB gzip blob (4.55 MB raw: vmlinux plus BusyBox), gunzipped with fflate and compiled N times
at module scope:

| copies | raw wasm | `Worker Startup Time` |
| --- | --- | --- |
| 1 | 4.5 MB | 83-109 ms |
| 5 | 22.7 MB | 399 ms |
| 10 | 45.5 MB | 583 ms |
| 12 | 54.5 MB | 715 ms |
| 15, 20 | 68-91 MB | rejected: `Script startup exceeded CPU time limit` |

A rejected upload leaves the previous version serving. The cost is ~13 ms per raw MiB, paid by every
cold isolate.

---

## The Toolchain

### The Build

linux-wasm builds in its own base image on paisley-park (`gmux-lw-base:3103d5c`, capped at 18 GiB):
`vmlinux.wasm` 3,637,180 bytes, BusyBox 1,490,235, `initramfs.cpio.gz` 661,058. LLVM at 20 compile
jobs was OOM-killed inside the cap; 12 finished. `linux-wasm.sh` clones the kernel with
`--shallow-exclude=v7.0`, the fork has no `v7.0` tag, and the clone fails with `fatal: expected
'packfile'`; gmux fetches by commit. The script names `mmu` variants, but the pinned kernel fork has no
MMU support: `arch/wasm/Kconfig` has no `config MMU`, `arch/wasm/mm/` holds only `init.c`, and there
are no page tables.

`scripts/build-linux.sh` is reproducible. Two runs from the same tree, one on a cached LLVM and one
that cloned and built its own, wrote the same bytes for every artifact in `SHA256SUMS`: the kernel,
libc, BusyBox, the initramfs, Katybug and the probes. `reproduce.yml` repeats the from-source build on
a GitHub runner against each published build's manifest. Every release carries an SPDX SBOM and
build provenance attestations.

### Kernel Patches

| change | why |
| --- | --- |
| `cpu_relax` calls `wasm_cpu_relax` | a spinning CPU must give up the host thread |
| idle's `memory.atomic.wait64` becomes `wasm_idle_wait(word, timeout)` | the Worker refuses the wait instruction |
| `delay` calls `wasm_delay`; reboot calls `wasm_halt` | no busy delay, a clean stop |
| `head.S` memory-grow retry shrinks by a page on failure | upstream retried the same size forever |
| `CONFIG_BOOT_MEM_PAGES` 512 MiB to 64 MiB | 512 MiB cannot be allocated in an object |
| `binfmt_wasm`'s program stack 8 KiB to 128 KiB | brk, and with it mallocng's metadata, starts at the bottom of the same mapping; 128 KiB is `binfmt_elf_fdpic`'s default |
| `binfmt_wasm` leaves brk no room | brk could grow to the top of the stack mapping, through the live stack |
| `ARCH_FORCE_MAX_ORDER` 14 | without an MMU an anonymous mmap is one contiguous block; order 10 capped allocations at 4 MiB |
| every syscall called at its built type | the dispatch cast handlers to the caller's argument count, and `call_indirect` traps on a mismatch |
| RAM up to the host's memory maximum | a fixed 64 MiB left a 256 MiB machine with 64; the grow request now shrinks by a 64th on failure |
| networking, file locking, inotify, `FHANDLE`, SysV IPC, POSIX queues, devtmpfs, AIO | the tinyconfig-based defconfig left 106 syscalls unbuilt, every socket call among them; 49 remain, each refused for the reason below |
| System V shm forwards its backing file's nommu mmap capabilities | without them every `shmat` returned `ENODEV` |
| `CLOCK_REALTIME` reads the host clock at boot | every machine believed it was 1970 |
| the host learns when a yielding task has a signal waiting | a thread spinning in user code never saw a signal or an asynchronous cancel |
| the host gets a stack's bounds; a trap that unwound a syscall restores the cpu flags | stacks grow in segments up to `RLIMIT_STACK` instead of overflowing into the mapping below; the next syscall after such a trap panicked |
| each syscall charges 250 ns to the clock | a deployed Worker's clock stands still while code runs, so time counted clock reads, not work |
| a busy cpu takes its interrupts when its task yields | interrupts ran only in idle, so a spinning task's own timer never fired |
| `binfmt_misc` | `execve` of an x86-64 or AArch64 ELF starts Katybug |
| a page owner table; `access_ok` checks a non-root task's buffers against it | without an MMU any process could write the kernel's and every other process's memory |
| a fork child's mm mirrors its parent's mappings, with its bytes in a memory of its own | nommu forked into an empty mm at the parent's addresses |
| the console takes an interrupt the host raises on input | khvcd polled the host every 10 ms, backing off to 2 s, so an idle machine kept calling out and a keystroke waited up to a second of machine time; now 0 polls per idle minute and the echo arrives in the same wake |
| `sched_clock()` reads the host clock | the arch had none, so the scheduler counted jiffies: task runtime and `CLOCK_PROCESS_CPUTIME_ID` moved in 10 ms steps, charged to whichever task was current when one passed |
| the host can refuse an executable, and the exec fails | the host could only throw for a program it holds no build of, which stopped the whole machine; now that process ends with `SIGSEGV` |
| `mlock` and its family, `mincore`, `msync`, `madvise`; `memfd_create` | MMU-only in `mm/`, so they returned `ENOSYS`; without an MMU every page is resident, so each checks its range and succeeds, `msync` writes a shared file mapping back, and `MADV_DONTNEED` zeroes or rereads its range as an MMU kernel's next fault would. `MEMFD_CREATE` had come only with `TMPFS`, which needs an MMU |

The host boots the kernel without `nohz_full`. With it, the timekeeping cpu never stops its tick,
so an idle machine woke the host about 220 times a second, and context tracking reads the clock
on every syscall. Without it, every idle cpu stops its tick.

| Node, `build/kernel`                       | `nohz_full`, jiffy `sched_clock` | no `nohz_full`, host `sched_clock` |
| ------------------------------------------ | -------------------------------- | ---------------------------------- |
| host waits per idle minute                 | 13,588                           | 264-290                            |
| 50 MB `sha256sum` pipe                     | 649-661 ms                       | 644-669 ms                         |
| `getpid` / `stat` / open+read+close, ns    | 47 / 189 / 399                   | 27 / 163-168 / 319-333             |
| cpu time of a 14-15 ms `nanosleep`         | 0 or 10 ms, by where a jiffy fell | 0.15 ms                            |

`scripts/kernel/unbuilt-syscalls.py` lists the syscall numbers whose table entry is still
`sys_ni_syscall` in a build. Each returns `ENOSYS`, and `tests/c/posix.c` checks every one:

| syscalls | why they are not built |
| --- | --- |
| `mprotect`, `remap_file_pages` | there is no MMU to enforce a protection; musl's thread code already accepts `ENOSYS` from `mprotect`, and Katybug keeps page protections for foreign guests itself |
| `process_vm_readv`, `process_vm_writev`, `userfaultfd`, `process_madvise`, `mseal`, `map_shadow_stack` | MMU-only in Linux |
| `mbind`, `get_mempolicy`, `set_mempolicy`, `set_mempolicy_home_node`, `migrate_pages`, `move_pages` | there is one memory node |
| `swapon`, `swapoff` | nothing can be swapped without an MMU |
| `init_module`, `finit_module`, `delete_module`, `kexec_load`, `kexec_file_load` | code arrives only with the deployment: a Worker cannot compile a module or boot a second kernel |
| `bpf`, `perf_event_open`, `seccomp`, the three `landlock_*` and three `lsm_*` calls | no BPF, PMU, syscall filter or LSM; the WebAssembly sandbox and the page owner table do the isolating |
| `add_key`, `request_key`, `keyctl` | no keyrings, and nothing here uses one |
| `io_uring_setup`, `io_uring_enter`, `io_uring_register`, `cachestat` | switched off in linux-wasm's defconfig and not measured on this kernel; `epoll` serves every program here |
| `fanotify_init`, `fanotify_mark` | not built; `inotify` is |
| `quotactl`, `quotactl_fd`, `acct` | no disk quotas and no process accounting |
| `pkey_alloc`, `pkey_free`, `pkey_mprotect` | no memory protection keys |
| `rseq`, `rseq_slice_yield` | the arch has no restartable sequences, and musl does not use them |
| 18, 42 | numbers Linux retired (`lookup_dcookie`, `nfsservctl`) |

### Linking User Programs

linux-wasm's `tools/fake-llvm/clang` treats a command as a link only when some argument starts with
`-l`. A link of `libz.a` or of sources alone gets none of its linker flags, and came out as a module
of 1,547 bytes (zlib's `minigzip`) or 1,797 (sqlite) with no entry. Its linker flags include
`--import-undefined`, so a missing function becomes an import and every autoconf function probe
passes: jq detected `gamma`, dash `killpg`, curl `_fseeki64`, xz `capsicum`. Its musl `crt1` defines
a strong three-argument `main` that forwards to `__main_argc_argv`, so an `int main(void)` program
links with no entry and a three-argument `main` is a duplicate symbol.

`scripts/cc-strict` is the CC that fixes all three. It links with `src/gmux/crt1.c`, links once to see
which `main` the program exports, generates `__gmux_main` for it, relinks with `-lc`, and fails on any
import outside the set a user program may have: `memory`, `__indirect_function_table`,
`__stack_pointer`, `__memory_base`, `__table_base`, `__wasm_abort`, `__wasm_syscall_0..6`.
`scripts/wasm-imports.py` reads imports and exports, because the toolchain's `llvm-nm` and
`llvm-objdump` cannot parse the final modules. `main(void)`, `main(argc, argv)` and `main(argc, argv,
envp)` programs built this way all run in a booted kernel.

### setjmp and longjmp

musl's wasm port shipped `setjmp` returning 0 and `longjmp` calling `abort()`. `cc-strict` now
compiles every program with LLVM's wasm exception-handling lowering (`-mexception-handling -mllvm
-wasm-enable-sjlj`) and links its runtime, `src/gmux/sjlj.c` and `src/gmux/sjlj-tag.S`. LLVM 18 emits
the Emscripten ABI: `saveSetjmp`, `testSetjmp`, `getTempRet0`, `__wasm_longjmp`, and the tag
`__c_longjmp`, which nothing else in the link defines and which clang 18 crashes on as file-scope asm
in C. Only functions that call `setjmp` are instrumented. The lowering matches calls named `setjmp`
and `_setjmp` but not `sigsetjmp`, so `src/gmux/include/setjmp.h` routes `sigsetjmp` through
`setjmp` and restores the saved mask on the second return, as musl's own `sigsetjmp` does.

In a booted kernel: a `longjmp` from ten frames down, three nested `setjmp` frames, and `siglongjmp`
out of a `SIGUSR1` handler with the mask restored all return correctly. The handler case unwinds
through `wasm_user_mode_tail`, which is safe because the kernel's syscall epilogue has already reset
its stack pointer. Signal delivery also called `__set_tls_base` unconditionally, and only programs
that link musl's clone code export it, so a small program could not take a signal at all.

### vfork

A wasm function cannot return twice, and a linux-wasm process's frames live on the host's JSPI stack,
not in the process's memory, so the child of a `vfork` can only run on the stack that holds the
parent's frames. `src/gmux/include/unistd.h` makes `vfork()` a `setjmp` in the caller, and
`src/gmux/vfork.c` does the rest with the host:

| step | where it runs |
| --- | --- |
| the parent's `clone(CLONE_VM \| CLONE_VFORK)` | a fresh host stack, as the parent; it waits there for the child |
| the child, from `vfork()` returning 0 to its `execve` or `_exit` | the parent's own stack, as the child task |
| the child's `execve` or `_exit` | a fresh host stack, as the child, so no kernel frame of it sits on the parent's |
| the parent's return | its clone returns the pid, and the shared stack `longjmp`s to the `setjmp` with it |

The host recognizes the child when it first returns to user mode: it starts on exactly the stack
pointer the parent's clone passed, and without an MMU no two processes share a stack address. The
task that switched to it says nothing, because a new task can start on any cpu. A child that dies
holding the stack (a signal, or `exit()` instead of `_exit()`) is unwound by an exception the host
throws with the program's exported `__c_longjmp` tag. A failed `execve` returns its error to the child
on the shared stack. In a booted kernel an unmodified C program's `vfork` runs `execve` of
`/bin/echo`, `_exit(7)` and a failed `execve` (`ENOENT`) with the right status each time. A checkpoint
refuses while a vfork is in flight.

### Syscall Dispatch

linux-wasm dispatched a syscall by casting the handler to a function of as many arguments as
userspace passed, and wasm's `call_indirect` traps unless the types match. musl's `pause()` is
`ppoll` with four of its five arguments; its futex calls pass three or four of six; each trapped in
the kernel. `arch/wasm/kernel/syscall_adapters.c` is generated by `scripts/kernel/syscall-adapters.py`
from the preprocessed syscall table and a built kernel: a handler's real type comes from the binary,
not its prototype, because `SYSCALL_DEFINE`'s alias leaves only `__se_sys_x` in a wasm build, an
unbuilt syscall is `sys_ni_syscall`, and wasm32's `rt_sigreturn` takes no arguments whatever
`syscalls.h` declares. Seven call shapes cover all 319 table entries. The adapters reference no
`sys_*` symbol, so rebuilding with them changes no handler's type; `scripts/kernel/adapters-check.sh`
regenerates after a config change until the file is a fixed point.

### Threads

Pthreads never worked on linux-wasm. Its variadic `__clone` read the TLS and clear-tid arguments only
under `CLONE_CHILD_SETTID`, and `pthread_create` passes `CLONE_SETTLS | CLONE_CHILD_CLEARTID` without
it: every thread started with `pthread_self()` = 0 and no clear-tid address, `pthread_join` never
woke, and the last worker's exit ended the process with status 0, which read as success. The musl
patch in `src/musl/patches/` reads each argument its flags use. Four threads counting 40,000 times
under a mutex and a condition variable, with `join`, are exact in a booted kernel.

### Signal Handlers

Handlers ran from inside `wasm_user_mode_tail`, a plain JS import, so a handler that blocked could
not suspend: a `SIGALRM` handler that sleeps threw `SuspendError: trying to suspend JS frames`. The
import is now `Suspending`, and the handler runs through `WebAssembly.promising` on a stack of its
own; its blocking syscalls park it like any code, and its sigreturn ends it with the same trap as
before. A checkpoint taken while a handler is parked unwinds the handler's stack first, then the
frames it interrupted through `wasm_user_mode_tail`; a restore rewinds them in the other order. A
nested handler, or one entered from a user-mode interrupt, still refuses.

### Package Census

Round 14, 48 recipes (`scripts/census.sh`, in `docker/census.Dockerfile`'s image), strict link
check, libraries installed into a per-run prefix so later packages link against them. 24 programs and
7 libraries build, against 15 in round 9. What moved them:

| change | packages it moved |
| --- | --- |
| cc-strict gives every mode the target's headers, `-fPIC` and `-shared`: configure preprocesses with `$CPP $CPPFLAGS` and no `CFLAGS`, so its probes had read no target headers | coreutils, findutils, tar, patch (gnulib found no `PATH_MAX`, skipped `chdir-long.c` and still called `chdir_long`); curl (no non-blocking method) |
| `GMUX_TARGET_RUN`: a configure's test programs run on gmux through `scripts/wasm/target-run.ts`; ssh and scp shims serve perl's Cross/run | nginx; perl's Configure completes |
| wasm-ld put archive members' local symbols in its lazy table (llvm patch 0001); gmux's `dlopen` archive, first on every link line, has statics named `error` and `fail` | bison and sed, broken since the `dlopen` archive arrived |
| `__dlsym_time64`, the name musl's `dlfcn.h` gives `dlsym` | redis, openssh, python |
| redis's `__attribute__((__common__))` crashes clang's wasm backend; the recipe declares those pointers weak | redis |

`scripts/wasm/config.site` holds the autoconf answers that recipes used to carry, and
`scripts/wasm/toolchain.cmake` builds lighttpd. perl's interpreter builds (3.5 MB) and its dynamic XS
extensions do not yet. nano and tmux now configure and stop at unresolved ncurses data symbols.

| result | packages |
| --- | --- |
| built, links with only the allowed imports | zlib, bzip2, sqlite, jq, GNU make, dash, sed, gawk, gzip, bison, lighttpd, dropbear, openssl, mbedtls, Lua, coreutils, findutils, tar, patch, curl, nginx, redis, openssh, CPython |
| library built | ncurses, readline, libevent, pcre2, expat, libxml2, jansson |
| needs a primitive the host lacks | libffi (no non-Emscripten wasm32 port) |
| needs a source patch | xz (`mythread_sigmask`); grep, diffutils, m4 (gnulib's `sigsegv` has no wasm stack-VMA code); bash (a `config.h` type) |
| recipe or build system | less, htop, vim (configure does not accept the ncurses build); nano, tmux (ncurses data symbols unresolved at link); zstd, lz4 (the program's own library symbols unresolved); git (`--allow-multiple-definition`); perl (dynamic XS extensions); file (runs its own binary to build `magic.mgc`) |

The dash build drops `--enable-static`, which adds `-Wl,--fatal-warnings`. autoconf's `char f()` probes
are a signature mismatch in typed wasm, so under fatal warnings every such probe fails. BusyBox's
`$(...)` fails because musl's `vfork()` here prints `vfork() is not implemented yet, use clone()
instead!`.

`EXTRA_CFLAGS=-msimd128` builds the same set with autovectorization (217 to 3,047 SIMD instructions
per program). Against the plain build, 5 rounds, arms interleaved: Lua 1.020, gzip 0.992, bzip2
0.991, sqlite 0.986, sed 0.987, gawk 0.997, inside the ~3% noise, at 0.1-2.8% more bytes. For
scalar programs a SIMD build buys nothing; SIMD pays where a kernel is written for it.

---

## Defect Classes

**An instrument that manufactured the effect it measured.** A curl per request stalled 35.04 s on TCP
connect from the client (`time_connect`), the object went idle past eviction, and the next request met
a new instance. 18 of 18 "replacements" in one run were that. They read as platform behaviour until
the connect time was logged. Rigs use one keep-alive client.

**A silent reset.** An object over its memory budget answers the current request and is gone before
the next, with outcome `ok` and no exception in the tail. Instance-count exhaustion looked like "an
event that ends with a CPU-bound job", then like "pipes", then like "fuel". Eight arms separated
them. Any "replaced after X" finding needs an arm that holds X constant and varies the process count.

**A link test that cannot fail.** A toolchain that imports every undefined symbol turns autoconf's
link probes into constants, so configure output was wrong in both directions: false successes that
broke the build later, and compile errors in code configure should have skipped. `cc-strict` makes
the link fail where the runtime would.

**A reading taken from survival instead of headroom.** The JSPI rig parked 20,000 deep stacks, the object
answered, and the conclusion "stacks are not charged" was written down. Survival says the limit was
not crossed; only a ramp beside the parked stacks says what they cost. The ramp showed they cost
~10-14 KiB each.

**A sentinel inside the range of real values.** An idle deadline was saved as time remaining, with
-1 meaning "none". A deadline already overdue at checkpoint time also came out negative, restored as
"none", and that CPU's timer never fired again; the restored shell looked dead in 1 of 2 runs. "None"
is now null and overdue is 0. A sentinel needs its own type, not a value the data can reach.

**A clock that stands still while code runs.** A deployed Worker's `Date.now()` returns the same
value for the whole of one event's execution. The kernel took that as its clock, so time froze inside
every event: a background job corrupted the shell's heap and `^C` could not interrupt a busy loop.
It read first as a defect in the asyncified kernel, because the crash only showed up deployed. A plain-kernel arm
crashed too, and a frozen clock under Node reproduced it offline. Any host clock gmux hands a guest has
to move forward on its own when the host's does not.

**A stack sized for a demo.** linux-wasm maps two pages for a program's stack and puts brk at the
bottom of the same mapping, and mallocng takes its metadata from brk. BusyBox never went deep enough
to notice. Lua's error path inside a coroutine under `pcall` did, and aborted in `free()` with the
heap's metadata record full of stack addresses. The allocator's record was intact at `setjmp` time
and overwritten by the time `longjmp` ran, which ruled out the new `setjmp` runtime; the stack
pointer 0x23c bytes above the record named the cause.

**Two limits a no-MMU kernel hides.** linux-wasm let brk grow from the bottom of the stack mapping
to its top, so musl's allocator extended its metadata straight into the live stack; brk now has no
room and the allocator uses mmap. And every anonymous mmap is one physically contiguous block from
the page allocator, so the default maximum order made 4 MiB the largest allocation any program could
make, with 47 MB free. Order 14 raises it to the kernel's RAM. Both surfaced from one Lua test.

**An upstream loop with no exit.** linux-wasm's `head.S` retried a failed `memory.grow` at the same
size forever, and a boot hung with no output. A retry needs a smaller request or a bound.

**A rig workaround that hid the defect it worked around.** `/dev/null` was a regular file. devtmpfs
does not mount itself over an initramfs, so `/dev` was a plain directory, the boot script's own
`2> /dev/null` created a file, and every later redirect appended to it until the OOM killer ran. Each
probe setup mounted devtmpfs by hand, and the POSIX probe checked only that `/dev/null` was
writable. `/init` mounts devtmpfs now, the setups do not, and the probe checks for a character
device that stays empty after a write.

**A test the optimizer deleted.** A probe mode that allocated memory until `malloc` failed never
read what it allocated, so clang removed the allocations, then assumed the loop left without side
effects would end (C11 6.8.5p6) and dropped the whole branch. The child the probe started for that
mode ran the probe's main path instead, which started another, and the output repeated forever. It
looked like memory exhaustion hanging the machine until the mode was typed at the shell by hand. The
allocations now go through a `volatile` pointer.

---

## Measurement Rules

1. **An absolute CPU figure comes only from `cpuTime` on a deployed Worker or object**, read from
   `wrangler tail --format json`. The clock does not advance during synchronous wasm, so an in-process
   delta reads zero.
2. **State n and a spread**, and give the instrument in the table.
3. **One keep-alive client per rig.** A fresh connection per request adds a random 35 s stall and an
   idle eviction.
4. **Fresh object names meet first placement.** A measurement that must not see it burns ~1.3 s first
   and confirms the instance changed.
5. **A limit is read by ramping to it beside the thing under test**, not by showing a workload
   survived.
6. **Deploy only to the Free account, tear down after the run, and verify the baseline**: no Workers,
   no Durable Object namespaces, two KV namespaces.
7. **paisley-park runs capped containers** (`--memory`, `--cpus`) under `~/gmux-rig/` and never
   touches `/hdd` or `/ssd`.

---

## Repository Layout

| path | what |
| --- | --- |
| `src/site.ts`, `src/site-do.ts`, `src/worker/ui/` | Worker entrypoint, the machine's Durable Object, the terminal page |
| `src/worker/machine/` | the machine host: the JSPI pump, checkpoints, the exec registry, `dlopen` (`dl.ts`) |
| `src/sources.json` | pins for linux-wasm, the kernel fork, the LLVM fork, musl, BusyBox and zlib |
| `src/kernel/`, `src/musl/`, `src/busybox/` | patches applied by the pipeline; the kernel's are GPL-2.0-only |
| `src/gmux/` | the C runtime linked into user programs: `crt1`, `setjmp`/`longjmp`, `vfork`, `dlopen` |
| `src/gmux/katybug/` | the x86-64, AArch64 and wasm frontends to the IR, its interpreter and plan, Linux syscalls and signals |
| `src/llvm/patches/` | toolchain fixes the pipeline applies before building LLVM (wasm-ld's lazy archive symbols) |
| `src/worker/placement.ts` | spending a new object's first-placement replacement before a machine exists |
| `src/rootfs/` | files the pipeline lays over linux-wasm's initramfs (`/init`, the `binfmt_misc` registrations) |
| `scripts/build-linux.sh`, `scripts/build-kernel.sh` | the reproducible pipeline (in Docker on a Linux host), and the step that stages its output into `build/` |
| `scripts/cc-strict`, `scripts/wasm-imports.py` | the strict CC for user programs, and its module reader |
| `scripts/wasm/` | module passes: fuel, stack checks, store guards, exec stubs, shared instances, export trimming |
| `scripts/payload.ts`, `release-payload.ts`, `hydrate.ts` | the build payload: `build/` packed deterministically, and a pinned one (`build.lock.json`) downloaded and verified file by file |
| `src/index.ts`, `scripts/package-kernel.ts`, `scripts/sbom.ts` | the npm package's entry, the kernel files it ships, and each release's SPDX bill of materials |
| `docker/`, `scripts/smoke.ts` | the image that runs the site under workerd, and a check that drives a running site's terminal protocol |
| `tests/unit/`, `tests/fixtures/` | the gate suite (`bun run test`) and the toy kernels and programs it drives |
| `tests/c/` | C probes booted in a machine (`tests/c/run.ts`) and Katybug's native checks (`tests/c/katybug/`) |
| `tests/suites/` | upstream suites (libc-test, Lua) against a native reference |
| `experiments/<topic>/` | one directory per measurement: a probe Worker, its `build.sh` for ignored inputs, and `scripts/` drivers |
| `experiments/jspi-parks/` | JSPI across instances; also the toy kernel/process machine the other probes import |
| `experiments/residency/`, `event-quanta/` | residency by socket kind and the two-socket design; quanta, first placement, fuel shapes |
| `experiments/object-memory/` ... `sparse-checkpoints/` | the memory budget, asset fetches, checkpoint strategies |
| `experiments/machine-checkpoint/` | the Asyncify handoff probe, and the whole-kernel checkpoint test over the boot rig's host |
| `experiments/boot/` | the kernel host's Worker (it re-exports `src/worker/machine/`) and the Node boot script |
| `experiments/quanta-job/` | the multi-event job and process-count drivers, run against the boot rig's Worker |
| `experiments/network/`, `dirty-tracking/`, `codegen/`, `publication/` | sockets, dirty-page tracking, startup compile and packs, deploys against live machines |
| `experiments/evacuation/`, `mmu/` | resumable frames (`evacuate.mjs`) and the control-flow checkpoint matrix; the software MMU bench and lazy restore |
| `experiments/console-interrupt/`, `syscall-cost/` | host calls and input latency of the console; host time per syscall |
| `experiments/exec-stubs/` | guest memory, exec time and image size with full executables against stubs in the rootfs |
| `scripts/tail.ts`, `scripts/probe.ts` | the `wrangler tail` parser and the gate drivers' shared client |
| `scripts/census.sh`, `docker/census.Dockerfile` | the package census, and its image (the toolchain with node, wabt and pkg-config) |
| `scripts/wasm/config.site`, `toolchain.cmake`, `target-run.ts`, `target/` | autoconf answers for the target, a CMake toolchain file, and running a configure's test programs on gmux (`GMUX_TARGET_RUN`, ssh and scp for perl) |
| `scripts/kernel/unbuilt-syscalls.py`, `adapters-into-patch.sh` | the syscalls a build leaves unbuilt, and regenerated syscall adapters put into patch 0004 |
| `experiments/katybug-profile/` | Katybug against native x86-64: timings and a CPU profile by phase |

---

## Verifying the Tree

```sh
bun install
bun run typecheck
bun run test          # the gate suite, toy kernels only
bun run format:check  # clang-format and prettier
bash tests/c/katybug/wasm-ops.sh  # Katybug's wasm frontend against V8 (needs a C compiler and wabt)
```

The probes boot the real kernel from `build/`, which is not committed. Either download a release's
build (`bun run hydrate`, checked against its `SHA256SUMS`) or build it on a Linux host with Docker
(`scripts/build-linux.sh <new dir>`, then `scripts/build-kernel.sh <dir>/out`). Then:

```sh
node --no-warnings --experimental-strip-types tests/c/run.ts            # every probe
FROZEN=1 node --no-warnings --experimental-strip-types tests/c/run.ts   # a clock that stands still
SHARE=1 node --no-warnings --experimental-strip-types tests/c/run.ts    # one instance per program
node --no-warnings --experimental-strip-types tests/c/katybug/transcript-gmux.ts  # amd64 userland
```

Katybug's native checks need a Linux x86-64 host for the reference side (`tests/c/katybug/run.sh`,
`ops.sh`), and the checkpoint matrix needs the boot rig staged
(`experiments/boot/scripts/stage.sh`, then `experiments/evacuation/scripts/control-flow.ts`).

Every command prints its own total. Run it rather than quoting a count from this document.
