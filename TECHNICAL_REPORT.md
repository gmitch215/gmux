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
| Lua 5.4.7's own suite, file by file | **30 of 32** on Free, against **29 of 32** native musl; the two agree on 31 files | `tests/suites/lua.sh`, Alpine reference on paisley-park |
| libc-test's pthread suite | **20 of 24** on Free | `tests/suites/`, Free |
| A non-root process reaching memory it does not own | `SIGSEGV` from the load or store, `EFAULT` from a syscall; the checked build costs **1.26-2.86x** on the census in Node and **1.94-3.78x** on Free (stores alone 1.09-1.46x); a fork child in its own memory computes at **0.93-1.00x** | `tests/c/isolation.c` (Node and Free), `experiments/mmu` |
| Checkpoint tax on user programs | resumable frames **0.977-1.023x** of the plain build on six census programs, against Asyncify's +63% | local wall clock, Node, interleaved |
| Restore of an evicted machine | exact **6 of 6** into its predecessor's pooled memory, 0 of 6 into a fresh allocation | `experiments/evicted-memory`, Free |
| Checkpoint of the whole booted machine, mid-pipeline | **18-53 ms**, 73 stacks in 17.3 KB; restore 19-52 ms; 11 of 11 exact | local wall clock, Node |
| Asyncify tax on a CPU pipeline | **+63%**, almost all in the user program; kernel +3-9% | local wall clock, Node, interleaved |
| Native wasm compiled at startup from compressed bytes | **54.5 MB** in 715 ms; 15 copies rejected | wrangler `Worker Startup Time` |
| Package census | **24 programs and 7 libraries** of 48 recipes build and link cleanly | `scripts/census.sh`, paisley-park |
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
into linear memory, then packed dirty pages in SQLite. It restores a booted kernel mid-job exactly,
deployed on Free, after a forced eviction.

**Checkpointing cost user programs, not the kernel, until resumable frames.** Asyncifying BusyBox
adds 63% to a CPU-bound pipeline; asyncifying the kernel adds 3-9% to the same job and 35% to boot.
Resumable frames replace Asyncify in user programs: a call that can reach a syscall spills the
frame's live locals when a checkpoint unwinds it, and six census programs run at 0.977-1.023x of the
plain build. Only the kernel stays asyncified.

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
parent's memory eagerly and cannot share memory with other processes. Checkpoints do not save
shared instances or a fork child's own memory, and the terminal site's rows and CPU per idle day
are not read. Also unmeasured: any serving workload, execution memoization, publication of
proven responses, energy, and a deployed run of the latest kernel (console interrupt, scheduler
clock, exec stubs). None of it has a number, and no figure here stands in for one.

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
JavaScript frame. wasm isolates no process from another. A page owner table in the kernel keeps a
non-root process from writing memory it does not own (Isolation, below); root processes share one
trust domain.

### One Host Thread, Suspended by JSPI

linux-wasm's browser host backs each task with a Web Worker and blocks it in `Atomics.wait`. A
Durable Object has one thread and refuses `Atomics.wait`. Every blocking host import is instead a
`WebAssembly.Suspending` function, every entry into a task goes through `WebAssembly.promising`, and a
pump in `src/worker/machine/machine.ts` resumes exactly one task at a time by resolving the promise of
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
is in linear memory. `scripts/wasm/export-globals.ts` exports the five as `gmux_*`, and the
host's `sharedKernel` mode saves them when a task parks and restores them before it resumes. A new
task starts from the values a fresh instance would have.

| | per-task instances | one shared instance |
| --- | --- | --- |
| Instances after boot | 48 (37 at `maxcpus=1`) | 1 |
| Node heap after boot and a job | 47.4 MB (a 3-process pipeline) | 23.5 MB (two pipelines and 8 more processes) |
| Node RSS, same runs | 171.9 MB | 96.3 MB |
| Deployed: processes before the object resets | ~10 in its lifetime | none reset: 16 in one event; a 3-stage pipe in each of 6 events |

A user program is one instance per process by default, because `__memory_base` and `__table_base`
are immutable and differ per process. Each program keeps only the exports the host calls and sizes
its function table from a `gmux.table` note, which cut JS heap per BusyBox process from 820-907 KiB
to 31 KiB, and fifty processes from 70.6 to 11.7 MiB (`experiments/instances/scripts/cost.ts`). A
BusyBox instance cost ~1.9 MiB of the object budget before that trimming.

`MachineOptions.shareInstances` runs every process of one program on a single instance instead
(`scripts/wasm/share.ts` makes it shareable). At each switch the host swaps the memory base, the
stack pointer and the globals, and it copies a pristine data image to each new process. Against one
instance per process: about 10 KiB of JS heap per process instead of 115-125 KiB (6.1 MiB against
18.4 MiB at 50 processes), no instantiation, 300 fork/exec pairs about 19% faster, CPU-bound work
unchanged. The BusyBox transcript is byte-identical and every probe passes with it on. Checkpoints do
not save shared instances yet, so it is off by default.

### Fuel Safepoints

A build-time pass (`scripts/wasm/fuel-pass.ts`, prototype) decrements a counter at loop
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

A job with no terminal attached needs events from somewhere else. Two objects holding one standard
WebSocket between them, each quantum ending with a message to the other, ran 1,000 quanta in both
directions on one instance with a JSPI-parked stack alive, writing no rows and making no
subrequests (`experiments/baton`). An alarm per quantum ran the same 1,000 at one row each, in 148 s
against 76-82 s. A chain of requests between objects stops at 8 quanta: requests are causal, and the
platform's subrequest depth is 16 hops.

### Checkpoints

A parked task's stack is opaque to the host. To checkpoint, the host wakes the park with "unwind",
starts Asyncify's unwind inside the resumed host call, and the whole stack (process frames and kernel
frames) lands in linear memory. Restore rewinds into fresh instances and stops at the innermost import,
back in its JSPI park. Warm switching never pays for this; the Asyncify instrumentation tax is paid on
the calls it instruments.

On the booted kernel, `Machine.checkpoint()` in `src/worker/machine/machine.ts` does this for every
task. The kernel and BusyBox are asyncified at their park imports
(`experiments/machine-checkpoint/scripts/build-async.sh`), and all
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
(`experiments/evacuation/scripts/evacuate.ts --resume`). A call that can reach a syscall or a fuel
yield is wrapped so a checkpoint spills the frame's live locals; only the kernel stays asyncified.
Each such function gets a resume copy that reloads its frame and runs on from the recorded call: a
block resumes inside the child holding it, a loop finishes its current iteration from a copy and
then runs as written, and a loop resumed at its own fuel yield is entered at its head instead. A
saved value that is a cheap expression of other saved values at that call (`p = n + 16`) is not
saved; the resume recomputes it. The program is optimized before it is flattened, since each copy
adds a caller to every call it repeats and a later `-O2` would no longer inline a function that had
one. A side module loaded with `dlopen` imports the program's unwind state, so a stack that runs
program, then library, then program again resumes too. (`--fold` resumes inside each function
instead of a copy: a smaller module, and slower on the census, below.)
`experiments/evacuation/scripts/control-flow.ts` checkpoints recursion, function pointers,
`setjmp`/`longjmp`, a `qsort` callback, a signal handler, a side module calling back by pointer and
by import, and Lua inside `pcall` inside a coroutine; the harness refuses a checkpoint that lands
outside the phase it tests, and each restore is exact.

The census bench (`experiments/mmu/scripts/bench.ts`) builds each arm as the host does:
instrumented first, so every loop's fuel yield is a safepoint, then evacuated. Ratios against the
plain instrumented build, on V8. The x86 columns are a Ryzen 9 9900X core pinned in a container
(Node 26.10, three runs of 25 rounds, lowest to highest); the arm64 column is a laptop (Node 26.8,
7 rounds, about 3% noise):

| program | `-O2` only, x86 | handlers only, x86 | `--resume`, x86 | `--fold`, x86 | `--resume`, arm64 |
| --- | --- | --- | --- | --- | --- |
| lua | 1.02-1.05 | 1.03-1.08 | 1.04-1.07 | 1.04-1.08 | 1.00 |
| gzip | 1.01-1.02 | 1.02 | 1.03 | 1.04-1.05 | 0.99 |
| bzip2 | 0.98-1.00 | 0.98-1.00 | 0.98-0.99 | 1.00-1.01 | 1.01 |
| sqlite | 1.05-1.06 | 1.02-1.04 | 0.99-1.05 | 1.63-1.69 | 1.00 |
| sed | 0.96-1.02 | 1.01-1.06 | 1.01-1.06 | 1.39-1.44 | 1.06 |
| gawk | 0.97-1.15 | 1.02-1.11 | 1.04-1.09 | 1.55-1.60 | 1.05 |

The resume copies cost what the handlers cost; what is left is binaryen's `-O2` over the
flattened program and the try regions themselves. With every function compiled optimized up front,
sed's copies run at 1.01 and its folded build at 1.20, so the fold's cost is its dispatch tests on
the normal path, not tier-up. Size, since the fuel pass puts a safepoint on every loop back-edge
(26,655 sites in BusyBox):

| BusyBox, fueled | size |
| --- | --- |
| plain | 1.45 MB |
| a resume copy of each function (`--resume`) | 16.2 MB |
| resume folded into each function (`--fold`) | 8.8 MB |

Entering loops at their fuel yield took the copies from 17.2 MB to 15.0 MB, recomputing values
(164,455 saved values down to 144,958) to 14.3 MB, and optimizing before flattening back to
16.2 MB. At about 13 ms of startup per MiB of native code, BusyBox's copies cost about 200 ms.

After a restore (`experiments/evacuation/scripts/restore-bench.ts`: checkpoint at 30% of the
run's fuel yields, restore, time to the end, every run's output checked), the copies run as they
did before it when their modules are already compiled: on two pinned x86 cores lua 0.99-1.00, gzip
1.05, bzip2 1.01, sed 1.01-1.06, gawk 1.05-1.17 against plain from the same yield. Restored into
freshly compiled modules, as a new isolate would be, they run 1.13-1.22 (lua), 1.14-1.15 (gzip),
1.79-1.85 (bzip2), 1.24-1.25 (sed) and 1.45-1.55 (gawk) against a freshly compiled plain run, which
had warmed up over the part before the yield. sqlite's rest is too short to separate from its
compile. `reenterAfterRestore` spills the restored frames once more at a later fuel yield and
resumes them in the same instance, so frames rebuilt in unoptimized code re-enter what V8 has
optimized since; at 10 ms it moved none of these, so the cold cost is compiling and tiering the
new module, not frames held in old code. On one pinned core V8's background compiles of each
fresh module land on whatever run comes next, and the restore rig does not measure there.

Where the cold restore goes was split under node 26.8 (V8 14.6) on six programs, each with V8's
compile flags changed one at a time. Instantiation is 0.2-2.1 ms and construction 3-38 ms, before
the timed part. The rest of cold minus warm is 7-86 ms (lua 13.6, gzip 14.5, bzip2 76.2, sqlite
85.9, sed 35.1, gawk 23.1), and compilation is 97-99% of it: lazy Liftoff compilation is 0-3 ms
(29 ms on sqlite) and tier-up is the remainder, 6-73 ms. The control, the default run first and
last, drifts by up to a factor of two on gzip and sqlite. The site already compiles its modules when
the isolate starts and a restore never compiles, so only those two costs can remain deployed.
Measured on Free, one image taken mid-job (a background `gzip -9` of 600,000 numbers, output
checked) was restored into 10 fresh isolates and 30 warm ones: cold 965 ms (940-1,227), warm 933 ms
(871-1,169), paired per redeploy +60 ms at the median (-22 to +220), Mann-Whitney z 2.89. That is
3-6% of the request; the same job under node is +55% (432 ms against 278 ms). A 92 ms warm-up at
isolate start removes the node penalty. On Free it would add 626 ms to every isolate start and save
nothing measurable, and the variant that warms only on a restore needs 58 subrequests against the
cap of 50, so the site has no warm-up. The deployed wall includes the asset fetches and `cpuTime`
was 0 in 34 of 50 rows, so compute and fetch are not separated. workerd keeps a compiled-module
cache across isolates (its documentation describes one); whether it holds optimized code is not
known, and it may be why the deployed penalty is small.

Changed pages are found at checkpoint time by hashing each 64 KiB page, packed with a small page index
into rows of up to 2 MB, and written only after `ctx.storage.sync()` succeeds. There is no store
barrier (Dirty Tracking, below).

### Write-Back and fsync

`src/worker/durable.ts` keeps a machine in SQLite as write-back rather than rewrite. A checkpoint
stores only the 64 KiB pages whose hash changed since the last one, 30 to a 2 MB extent row, plus
one page-map row and one row for the snapshot's host state; zero pages cost nothing. An extent row
is never rewritten, and one whose every page was replaced is deleted. A restore streams the extents
into the machine's memory one row at a time.

`fsync` and `fdatasync` are a per-file flush. When a host passes `fileSync`, each user program calls
a small router module (`src/worker/machine/router.ts`) instead of the kernel's `wasm_syscall_N`. It
sends the sync calls to a host hook and tail-calls the kernel for everything else, so a
checkpoint's unwind and rewind never see a router frame. The hook reads the file through the kernel
in the calling task's context (the path from `/proc/self/fd/N`, `statx`, then a fresh descriptor
read into the process's spill mapping), hands the bytes to the store, and lets the kernel's own
sync run only after the rows are durable. A file up to 1.9 MB goes whole into its record row, one
row a sync; a larger one writes its changed 4 KiB blocks into extent rows. Other dirty state waits
for the next checkpoint.

The other durability calls take the same flush:

| call | what the hook flushes |
| --- | --- |
| `fsync`, `fdatasync`, `sync_file_range` | the file behind the descriptor |
| a write to a descriptor opened `O_SYNC` or `O_DSYNC` (`write`, `writev`, `pwrite64`, `pwritev`, `sendfile`, `splice`, `copy_file_range`), or `pwritev2` with `RWF_SYNC`/`RWF_DSYNC` | that file, after the kernel's write returns |
| `msync` with `MS_SYNC` | every file mapped over the range, by `/proc/self/maps` |
| `sync`, `syncfs` on the root filesystem | every regular file on it whose ctime is newer than the checkpoint the machine continues from, then a removal record for each file synced since that checkpoint that is gone |

The router hands the hook the write family only after a program has opened a file with `O_DSYNC`
(the flag is saved in the snapshot), and the hook checks the descriptor's flags with `F_GETFL`, so a
machine that never opens a synchronous file pays nothing on its writes. `sync` walks the filesystem
instead of taking a checkpoint: a checkpoint needs every task parked in the kernel, and the caller is
inside the hook until its call returns. The walk reads only files changed since the checkpoint, and
`syncfs` of proc or devtmpfs has nothing to keep. `close` flushes nothing, as on Linux: a closed file
stays in the kernel's page cache and reaches storage with the next checkpoint or sync.

A lost machine restores from its last checkpoint, and every file synced after it is written back
through the kernel at the first syscall any program makes, before that syscall runs. A checkpoint is
refused while a sync is in flight or before the files are back. The machine resumes at the
checkpoint while those files hold their synced contents, so a program that appends after a restore
can repeat its last appends; a checkpoint soon after the sync narrows that window.

`src/worker/schedule.ts` sets the checkpoint interval by Young's optimum `sqrt(2 C M)`: `C` is the
smoothed checkpoint cost, `M` the mean machine time between losses, 30 minutes until one is seen and
then the observed rate. It is counted in time the machine ran, it is never shorter than the
machine's share of the daily rows budget allows, and it never exceeds half the mean time between
losses. `Alarm` keeps one Durable Object alarm for the earliest of any named deadlines (a Linux
timer from `Machine.deadline`, a checkpoint coming due) and moves it only when that deadline comes
sooner, since every `setAlarm` writes a row.

`src/worker/keeper.ts` joins the three for the site. It restores the last checkpoint and the files
synced after it when the object lost its machine, and boots one when nothing is stored. It
checkpoints when the interval comes due and continues the machine in place (`Machine.resume`: the
memory already is the image, so nothing is read back or copied). It points the alarm at the
machine's next Linux deadline and at unsaved work one interval ahead. An idle kernel always has a
timer within 0.5-4 s (its own housekeeping, measured under Node), so taken literally the earliest
deadline would wake an idle object about once a second. An unattended machine is therefore not
woken sooner than a quiet period that doubles from 1 s to an hour while it runs without output,
input or a file sync, and drops back to 1 s when it does something. A user's timer fires late by
about as long as the machine had been quiet. With a warm socket attached, the socket drives the
machine and only unsaved work wants the alarm.

Idle wakes were measured once the site ran unattended. An alarm wake slept in 50 ms steps until its
5 s wall budget ended, and a turn that ended on the budget counted as activity, so the quiet period
never backed off: on Free a machine doing nothing woke every 5.94 s and billed 4,972 ms of wall a
wake (111 wakes in 653 s). That is 14,546 wakes and 9,257 GB-s a day, 71% of Free's 13,000 GB-s.
Ending an unattended turn at its first wait for a Linux timer took the wall to 91 ms and the day to
136 GB-s. A keep-or-drop rule (`src/worker/thermal.ts`) keeps a wake when the chance of another use
inside its window, times the cost of the restore it saves, exceeds the request, row and idle wall
the wake costs, all priced in parts per million of Free's daily Durable Object meters. With ten
minutes of history it drops every idle wake: a wake costs 20 ppm and the restore it saves 0.72 ppm.
On a deployed object it kept 80 wakes with no history, dropped at the first idle wake after ten
minutes and armed no alarm after; in its first 11 minutes the meters read 89 requests, 67 rows
written and 0.816 GB-s.

Dropping every wake stops a silent background job after ten minutes until someone attaches, so the
wake policies were also measured over four hours of virtual time on the real kernel, with the object
replaced at every wake, on a silent `sleep 60` loop (240 iterations ideal). Keeping every wake with a
checkpoint at the end of each costs 14,134 rows a day at a 1 minute floor (237 iterations; 7 idle
machines fit in Free's rows meter), 872 rows and 94 wakes at a 15 minute floor (23 iterations; 114
machines), and 165 rows and 19 wakes at a 60 minute floor (11 iterations; 608 machines). Without a
checkpoint at the end of a kept wake every policy loses the silent job's state when the object is
replaced. The quiet period, kept in the instance, restarted at 1 s after a replacement and cycled 2,
4, 8 and 16 second wakes: 10,071 wakes a day for a machine used every 3 minutes with every wake
kept, against 2,386 when it is stored with the cadence. The defaults are now a 15 minute floor with
a checkpoint at each kept wake, the stored quiet period, and an unattended turn that ends at a wait
over 100 ms: that adds about 20 ms to an idle wake in the simulation (30 to 53 ms) and gives a job
that sleeps briefly 22 times the throughput per woken event. The wall budget was found unenforced
on the deployed clock, since `Date.now()` stands still while code runs and a guest waiting every few
milliseconds ran one event of about 15 minutes (110-115 GB-s); waited time now counts against it.
The new defaults have not yet run on Free.

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
carries console bytes. The warm socket is standard and keeps the object resident; while it is open
the page sends a tick each second on the control socket, which gives the machine a 5 s quantum in an
event of its own (CPU per Event); a keystroke gives it 250 ms. A hidden page closes its warm socket. The object keeps its machine through the keeper (Write-Back and fsync), so a
machine evicted after its last socket closes comes back from its last checkpoint on the next
keystroke or alarm, with every file synced since then. The site runs the asyncified kernel and
BusyBox that `scripts/wasm/asyncify.sh` builds into `build/kernel`; the guarded BusyBox and
katybug are not asyncified, and a checkpoint is refused, and tried again later, while either is on a
stack. All sessions share the one console.

### Executables

A Worker refuses `WebAssembly.compile` at request time. linux-wasm's `wasm_load_executable` compiles
bytes read from the kernel's filesystem, so gmux resolves every `execve` through a registry keyed by
SHA-256 of modules compiled at deploy or at isolate startup. Module scope may compile any bytes present
in the deployment, including decompressed ones: one 1.66 MB gzip blob becomes vmlinux plus BusyBox,
compiled natively, at startup.

Since the host already holds every module, the rootfs does not need the code. The build replaces each
wasm executable in the initramfs with a stub (`scripts/wasm/exec-stubs.ts`): the header, the
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

### Isolation

Kernel patch 0014 keeps an owner for every page of the shared memory: a process's tag for its
private pages, and a region's tag for a shared mapping, with a set per process recording the regions
it maps and whether it may write them. A non-root process runs a build of its program that checks
each load and store against both (`scripts/wasm/guard-pass.ts`), and `access_ok` refuses a non-root
task's syscall buffers outside its own pages and regions. A non-root process that reads or writes the
kernel's memory, another process's, or a shared segment it never attached gets `SIGSEGV`, and
`EFAULT` from a syscall (`tests/c/isolation.c`, 27 checks, in Node and on Free). Root processes run
the plain build. Four of the checks take a page away while the reader is parked: a sibling thread
unmaps it (the reader at a fuel yield, or in `sched_yield`) or detaches its segment, and the reader's
next load of it must end with `SIGSEGV`. nommu refuses `MAP_FIXED`, so a page reaches another owner
only through an unmap.

Checking loads exposed a musl bug: `fcntl`, `ioctl`, `prctl` and `ptrace` read a variadic argument
the caller never passed, and a call with none passes a null va_list on wasm, so `fcntl(fd,
F_GETFD)` loaded address 0 (musl patch 0009). On the census under V8
(`experiments/mmu/scripts/bench.ts`, a `guardsi` arm for stores alone):

| | lua | gzip | bzip2 | sqlite | sed | gawk |
| --- | --- | --- | --- | --- | --- | --- |
| stores checked | 1.46 | 1.09 | 1.41 | 1.39 | 1.30 | 1.35 |
| loads and stores checked | 2.37 | 1.26 | 2.19 | 2.86 | 2.78 | 2.36 |
| loads and stores checked, deployed on Free (`cpuTime`) | 3.05 | 1.94 | 3.78 | 3.09 | 3.12 | 3.44 |

The deployed row is the median of 4-5 runs per arm on `experiments/boot`, the program run as uid
1000 through a launcher whose own cost (6 ms) is taken off; every output matched the root run.

Few of these checks can move out of the access. `experiments/mmu/scripts/provable.ts` classes each
access by its address (a local plus a constant, or computed) and counts each class as the census
runs. Full checks left per 1,000:

| | lua | gzip | bzip2 | sqlite | sed | gawk |
| --- | --- | --- | --- | --- | --- | --- |
| one check per base per straight run | 789 | 971 | 713 | 766 | 801 | 806 |
| bases checked once at their loop or function entry | 761 | 987 | 669 | 718 | 693 | 763 |
| and stack-pointer accesses free | 761 | 987 | 656 | 681 | 602 | 727 |
| and a page cache per access site, per call | 27 | 345 | 108 | 322 | 390 | 439 |

Pages repeat, so a cache covers what proof cannot. Ownership changes only while a process is parked
(one thread runs every task), so a cache re-read after each call, wait, loop head and catch is sound,
and the revocation checks above catch one that is not. Built with a kernel counter of revocations,
it ran slower than the lookup it replaces: 2.02-4.16x on the census against 1.25-2.74x, and an
unsafe cache that is never dropped was still 1.45-4.06x. The owner table is 64 KiB and stays in the
L1 cache, so its lookup costs about what the compare does, and a cache per site adds thousands of
locals. The code was removed.

A process in its own `WebAssembly.Memory`, as a fork child is (kernel patch 0015), needs no check:
V8 bounds every access. `experiments/mmu/src/own.c` runs one suite in the shared memory as root,
in a fork child, and as uid 1000 under the checked build (`scripts/own-memory.ts`, Node):

| against root in the shared memory | stream | chase | mix | sort | getpid | stat | 4 KiB pipe | 64 KiB pipe |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| fork child, own memory | 0.93 | 1.00 | 1.00 | 0.98 | 1.00 | 6.00 | 2.85 | 2.20 |
| uid 1000, checked build | 3.59 | 1.01 | 1.02 | 1.38 | 0.92 | 1.16 | 1.06 | 1.06 |

Compute runs at native speed in its own memory. A syscall that copies a user buffer crosses into the
host for each copy (1.5 us more per `stat`, 0.6 us per 4 KiB write and read), and the memory is
charged to the process's highest address (42 MB here).

### Foreign Executables

Katybug (`src/gmux/katybug/`) runs x86-64 and AArch64 Linux ELFs inside the machine: `binfmt_misc`
hands a foreign ELF to `/bin/katybug`, which decodes basic blocks into the gmux IR and interprets
them, turning guest syscalls into the machine's own. Guest addresses are 64-bit and live in
mappings, each backed by 64 KiB host blocks allocated on first touch, so a guest can map above 4 GiB (PIE at
`0x555555554000`, the stack below `0x7ffffff00000`, `mmap` from `0x100000000000`) while the machine
stays wasm32.

Each load and store in a decoded block keeps an inline cache of the last mapping it hit: its range,
its host block and a generation. Every change to the mappings (`mmap`, `munmap`, `mprotect`, `brk`)
bumps the generation, which stales every cache at once. Mappings never overlap: `munmap`,
`mprotect` and `MAP_FIXED` split the ones across a range's ends, each piece in its own block. On an amd64 `sqlite3` workload,
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

A signal the process inherits as ignored stays ignored for the guest, as `execve` keeps it on Linux.
Katybug had started every guest disposition at default while the host's stayed ignored, so a guest
asking `sigaction` was told "default". A CI runner starts its steps with `SIGPIPE` ignored, which is
where it showed.

A mapping is a table of host pieces, not one block. The no-MMU kernel hands a wasm process memory as
contiguous runs, and an 8 MiB stack, a grown heap or a 1.3 MB executable read whole asks for a run
that fragmented memory does not have: a 1,335,296-byte request failed in a 50 MB machine (800 wasm
pages) with 17 MB free. Each mapping now owns 64 KiB pieces allocated zeroed on first touch, so a
stack costs the pieces it touches. An inline cache covers one piece; a load or store that crosses a
piece boundary misses it and is served through both pieces. `read`, `write`, `readv`, `writev`,
`send` and `recv` go piece by piece, a small range that crosses a boundary and must be flat is
bounced through a buffer of at most 64 KiB, and the ELF loader reads each segment straight into its
pieces instead of reading the file into one block. Pieces of 16 KiB and over come from `mmap`,
because a `calloc` of 64 KiB is padded to 17 pages and the nommu kernel serves that from an order-5
run. The native suite passes 35 of 35, the transcripts 117 of 117 lines on both architectures, the
instruction corpora (32,045 and 14,993 cases) are equal, and 15 machine probes pass in three modes.
Piece size was timed in a machine under node, 4 KiB against 64 KiB over 9 rounds, as the ratio of
per-round medians: 1.017 on a loop inside one piece, 1.002 on a linear walk, 1.069 on a load per
4 KiB and 1.178 on a load that straddles a 4 KiB boundary, so 64 KiB stays. Coreutils' 516 tests
still pass 0 at 800 pages (native 353). The kernel asks for a 33-page run for each exec's stack (128
KiB and an argument page), which the allocator rounds to 64; after 104 execs an 800-page machine has
60 to 76 free runs of 32 pages and none of 64. At 1,200 pages, with 64 KiB `calloc` pieces, 39 tests
pass, 402 fail and 75 skip.

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

Four taxes in the dispatch loop were measured behind build switches, each keeping the corpus, the
transcripts and the signal checks exact, and are now gone from the only path: the per-instruction
`KB_PC` op (each op's instruction offset lives in a side table, 4 bytes an op), the fault check after
every op (only ops that can fault check), the zero register's reset after every op (its writes go
to a sink), and reading both operands ahead of the switch. Each build ran alone on paisley-park,
pinned to one core, 3 rounds, under two V8 versions; Katybug's time in the machine against the
build with all four taxes (`experiments/katybug-profile/scripts/variants.sh`, `bench.ts` with
`VARIANT`):

| workload | V8 | plain | `KB_PC` | fault check | zero | operands | all four |
| --- | --- | --- | --- | --- | --- | --- | --- |
| factor | 14.6 | 3,682-3,697 ms | -17.4% | -7.6% | -6.3% | -12.7% | -15.7% |
| sqlite | 14.6 | 4,128-4,151 ms | -11.0% | -4.8% | -2.4% | -5.9% | -13.4% |
| sha256 | 14.6 | 1,895-1,928 ms | -10.9% | -5.6% | -1.5% | -6.2% | -14.5% |
| factor | 13.6 | 3,663-3,677 ms | -14.3% | +3.9% | -0.4% | -11.7% | -26.8% |
| gzip | 13.6 | 9,967-10,091 ms | -10.3% | -2.6% | -1.4% | -12.3% | -22.0% |
| bzip2 | 13.6 | 16,592-16,609 ms | -12.2% | -0.2% | -1.5% | -12.0% | -25.9% |
| sqlite | 13.6 | 4,092-4,132 ms | -9.6% | -0.5% | +0.1% | -7.1% | -18.8% |
| bash | 13.6 | 24,119-24,180 ms | -9.8% | +0.2% | +0.6% | -7.5% | -18.3% |
| sha256 | 13.6 | 1,901-1,917 ms | -10.2% | -1.5% | -1.9% | -10.4% | -24.8% |

V8 14.6 is Node 26.10 and V8 13.6 is Node 24.21. The plain build runs at the same speed on both, but
the lean builds do not: on V8 13.6 the fault check and zero-register switches are worth nothing and
the other two add up, while on V8 14.6 all four together gain little more than `KB_PC` alone. Those
taxes are 13-27% of Katybug's time, depending on V8; the rest is interpretation itself.

What translation can reach was measured by lifting instead of interpreting. A `-DKB_HOT` build dumps
every block it ran with its IR and run count; `experiments/aot-oracle/scripts/lift.ts` writes the
blocks holding 99% (or 99.9%) of the executed ops as C, one function per process, with guest
registers and flags in locals and `goto` between lifted blocks. Loads and stores go through the same
inline caches as the interpreter's, and a fault leaves the registers as the interpreter would. A
`-DKB_AOT` build attaches that code to a decoded block only when the block's IR matches the lifted
copy exactly. The outputs equal the interpreter's. `r` against native x86-64, in a machine and
natively:

| workload | interpreter, in gmux | lifted 99%, in gmux | lifted 99.9%, in gmux | lifted 99%, native x86 |
| --- | --- | --- | --- | --- |
| factor | 79-82 | 9 | 8 | 5 |
| sqlite | 269-283 | 29 | 23 | 25 |
| sha256 | 329-342 | 9 | 10 | 10 |

The lifted code runs nearly as slowly compiled for x86 as it does in the machine, so wasm and V8 add
little: the representation carries the rest. Every load and store still checks its cached mapping's
generation and range; removing the range check crashes both workloads that were run without it, so
the check can only move to a block or loop entry. The pending-signal check at each block
transition is 16% of sha256. In wasm, x86's 128-by-64-bit `div` becomes a compiler-rt call (about a tenth of
factor), and the interpreted 1% is 6-10% of the samples. The first lifting called the flag helper
instead of inlining it, which put the flags in memory and cost 13-17% of the samples; forcing it
inline took factor, sqlite and sha256 from 11, 34 and 12 to 9, 29 and 9. katybug.wasm grows from
239 KB to 1.35 MB with the 99% lifting. Peak RSS natively is 1.5 MiB for the binaries, 4.8-9.3 MiB
under Katybug, and 0.1-1.2 MiB more with the lifted code.

Hardware counters on the native lifted build (`experiments/aot-oracle/scripts/native-profile.sh`,
`perf` on paisley-park, each workload ten times larger) show where the native 5-25x goes. The
lifted regions hold 78-88% of the samples, dispatch 6-10%, translation up to 5%, and the
out-of-line memory slow path under 1%. The lifted code does not stall: branch misses are at most
1.1% of branches and cache misses under 0.1% of references. It executes too many instructions:

| workload | instructions, lifted over native | cycles, lifted over native | IPC lifted | IPC native |
| --- | --- | --- | --- | --- |
| factor | 13.4x | 5.1x | 4.38 | 1.67 |
| sqlite | 24.6x | 28.6x | 2.97 | 3.44 |
| sha256 | 4.6x | 8.5x | 3.74 | 6.87 |

Natively the 128-bit division stays under 0.5% of the samples, so its tenth of factor is a wasm
cost. Without the signal check sha256 runs 9.8% fewer instructions and 8.8% fewer cycles; factor and
sqlite move by under 3%.

Guest state is not what the lifted code carries. A `-DKB_COUNT` build
(`experiments/aot-oracle/scripts/counts.sh`) counts, per 1,000 guest instructions, the words of the
cpu struct read and written and the mapping checks made:

| workload | cpu words read, interpreted | read, lifted | written, interpreted | written, lifted | mapping checks | checks per lifted region entry | mappings per region |
| --- | --- | --- | --- | --- | --- | --- | --- |
| sha256 | 16,466 | 61 | 10,542 | 41 | 91 | 308 | 1 |
| factor | 13,469 | 395 | 8,445 | 336 | 150 | 59 | 3 |
| sqlite | 15,633 | 730 | 9,549 | 640 | 418 | 63 | 8 |

A region's checks fall in a handful of mappings. The memory plan (`plan_mem` in `run.c`) follows
each register through a block as an entry register plus a constant, and loads and stores off one
root share a `KB_RESOLVE` at the block's start that resolves their whole span once; a span that is
not one mapping leaves each access its own check, so faults stay where they were. Lifted checks
fall to 28, 88 and 287 per 1,000 guest instructions, and the lifted code runs 8%, 3% and 13%
faster. The interpreter skips the resolves: using them cost it 2-3%, since dispatch dominates it.
Every IR op carries a semantic class (`kb_class` in `run.c`), and the flag and memory plans read
the classes, not opcodes.

How much of the remaining memory traffic one validated host offset could cover was counted from the
hot traces themselves (`experiments/aot-oracle/scripts/provenance.ts` over `-DKB_HOT` dumps with
exact per-exit weights). An access qualifies when its base is an entry register or a constant, so
one check of its window at the trace's start covers it; only a syscall can change mappings, and a
syscall ends a block, so nothing inside a trace invalidates the check:

| workload | provable | largest remainder |
| --- | --- | --- |
| factor | 91.2% | base plus index, 3.6% |
| gzip | 55.7% | base plus index, 41.2% |
| bzip2 | 44.9% | base plus index, 49.9% |
| sqlite | 68.4% | loaded pointer, 14.2% |
| sha256 | 87.3% | base plus index, 10.2% |

Every access the memory plan already groups comes out provable, and the outputs are equal with the
dump on and off. Mappings change 0.08-3.58 times per million block runs, so a check carried across
trace entries under a generation would rarely be invalidated.

The same lifted form was then built up one change at a time, on x86 and inside the machine, against
the native algorithm run through the same harness (`experiments/aot-oracle/scripts/ladder.sh`):

| rung | sha256 | factor | sqlite |
| --- | --- | --- | --- |
| base, r x86 / wasm | 7.9 / 9.4 | 5.2 / 8.2 | 18.4 / 23.8 |
| temporaries kept block-local | -9% / -7% | -10% / -19% | -12% / -4% |
| traces and trace-level groups | -17% / -4% | +2% / -1% | -15% / -20% |
| back-edge polls | -7% / -13% | -1% / 0% | -3% / -1% |
| provenance windows | -40% / -31% | -4% / -4% | -3% / -2% |
| all of the above, r | 3.3 / 5.0 | 4.5 / 6.3 | 13.0 / 17.8 |
| native algorithm, r | 1.14 / 1.20 | 0.96 / 1.38 | 0.66 / 1.12 |

Block-local temporaries pay everywhere; the provenance windows pay only on sha256. The four changes
close 68%, 16% and 31% of the distance to the native algorithm on x86, so most of it remains. Steps
under about 10% sit inside the spread between link orders on some rows.

Where the pending-signal check sits was measured with `-DKB_POLL`
(`experiments/aot-oracle/scripts/poll.sh`), lifted time against checking at every block:

| policy | signal corpus | sha256 | factor | sqlite | poll latency, mean / max |
| --- | --- | --- | --- | --- | --- |
| every block | exact | 0.043 s | 0.204 s | 0.401 s | 0.5 / 2.3 us |
| back-edges | fails | -20.9% | -4.4% | -9.0% | 0.8 / 2.7 us |
| back-edges and after each syscall | exact | -18.6% | -3.9% | -7.5% | 0.8 / 2.7 us |
| every 64 transitions | fails | -11.6% | +1.5% | -19.0% | 13.8 / 41.7 us |

Back-edges alone miss a signal a syscall makes pending (a `kill` of itself, a `sigprocmask` that
unblocks one), which must run before the syscall returns. The interpreter gains 0-3% from any
policy. The latency is from the host signal to the poll that sees it, under a `SIGUSR1` about every
millisecond into a bash loop with a trap. Katybug now polls at back-edges and after each syscall by
default; `-DKB_POLL=0` restores the check at every block.

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

Dynamically linked programs run with the guest's own loader: `elf.c` maps the `PT_INTERP` loader
beside the program and passes `AT_BASE` and `AT_ENTRY`, and ld-linux or ld-musl does the rest.
`tests/c/katybug/dynamic.sh` runs 29 lines in `debian:bookworm-slim` (glibc) and `alpine:3.20`
(musl) natively and under a static Katybug in the same container, on x86-64 and AArch64: coreutils,
awk, sed, tar, gzip, `getent`, perl loading XS modules with `dlopen`, `ldd`, a trapped signal, libm
and a pthread suite. All match. glibc needed a `cpuid` that reports the x86-64 baseline under a
vendor it knows (qemu64's AuthenticAMD, family 15, model 107; glibc reads the feature leaf only for
known vendors), `fxsave` for its lazy PLT resolver, and on AArch64 a sigreturn trampoline, since
glibc there installs handlers without `SA_RESTORER` and expects the vDSO's.

Guest threads run green inside one Katybug process, one at a time (`thread.c`), the way one isolate
runs one thread. A thread is a saved register set; memory, mappings and decoded blocks are shared. A
thread switches every 16,384 back edges, on a futex wait, or when a call would block: `read`,
`accept`, `poll`, `select`, sleeps and `wait4` first look at their descriptors with a zero-timeout
host `poll`, and if nothing is ready the thread parks with the call rewound and a deadline from its
first attempt. When every thread is parked, one host `poll` waits on all their descriptors. Futexes
live in the process. Since switches happen only between blocks, x86 locked instructions are atomic
as decoded, and the AArch64 exclusive monitor is cleared at every switch and signal so an
interleaved `stxr` fails and its loop retries. `tests/c/katybug/threads.c` (joins, a mutex counter,
atomics and CAS, condvars, TLS, `pthread_once`, semaphores, barriers, a pipe between threads,
overlapping sleeps, a preempted spin, rwlocks, `pthread_exit`, detached threads) matches native with
glibc and musl on both architectures. A process with one thread pays one compare per back edge.

AArch64 floating point and Advanced SIMD (`a64v.c`) are computed in software on exact
significands, because wasm has no rounding-mode control: every FPCR rounding mode, flush-to-zero,
default NaN, and FPSR's cumulative flags, with add, subtract, multiply and divide taking the host's
result when the mode is the default and the operands are ordinary. The AArch64 corpus
(`tests/c/katybug/a64-ops.sh`, native on Apple silicon through Docker) is 14,993 cases, FPSR
included, all equal. GCC's `-Wtautological-compare` found that an FP or vector load from a literal
(`ldr q0, label`) never decoded, since its match masked out the bit it compared; it had no case in
the corpus, and now has two. Signal frames carry the FP and vector registers on both architectures. The cost
is about 5 ns per scalar FP operation, and a vector fused multiply-add loop ran 45% slower than it
did before exactness.

Fused multiply-add now takes a host path at the default FPCR when its operands are finite. A
single-precision result comes from an exact double product with its rounding error carried in a
TwoSum and rounded to odd; a double-precision result from the host's `fma` plus Boldo and Muller's
error term, with the inexact flag read from the residual. Other rounding modes, flush-to-zero,
default NaN, NaN and infinite operands, zero factors, subnormal double operands and extreme
exponents go to the software core. On an Apple M2 Pro, against a build that gives every operation
the host's result, the `fmla` loop went from +62% to +6%, a mixed loop from +20% to +4%, and a
dependent pair of scalar `fmadd` from +70% to +13% (16,777,216 iterations, best of 3). The corpus
is equal with the planner on and off, and 30 million random cases each of double and single agree
with the software core, flags included. In a machine under node the fast path makes the `fmla`
loop 1.657 times faster than the software path, the mixed loop 1.077 and the scalar pair 1.050; a
loop that uses no fused multiply-add reads 0.996 (spreads up to 3.6%), which is the noise floor.

x86 `rep movs` and `rep stos` copy and fill forward in 1 MiB chunks of host memory, and element by
element up to the next page when a range is not one mapping, so a fault stops at the exact element
with `rcx`, `rsi` and `rdi` as native leaves them (`tests/c/katybug/x86-faults.c`). musl's `memcpy`
and `memset` are `rep` instructions, so this moves ordinary programs: sqlite with 80 MB of blobs
went from 24.95 to 17.32 s. A handler with `SA_RESTART` now runs while its thread is blocked in a
host call, which is then restarted as Linux restarts it; before, the host restarted the call itself
and the handler waited for the call to return. 128-bit multiplies and divides are 64-bit halves under
wasm (`wide.h`), so wasm32 code no longer calls compiler-rt's `__multi3`, `__udivti3` or `__divti3`;
lifted factor gained 3%.

Four libc string functions run as host kernels. Katybug recognizes `strlen`, `memcmp`, `strcmp` and
`memchr` by their code, not their names, since guest binaries are stripped: a block at a function's
entry whose length, first eight bytes and FNV-1a hash match musl 1.2.5's bytes gets a leading
`KB_PRIM` op, and those bytes occur exactly once in each static x86-64 and AArch64 binary and in
both musl loaders. A kernel reads the guest's pages directly and, if it reaches one it cannot read,
gives up before it changes anything, so the function's own ops run and the fault is the
interpreter's; twelve fault cases (a page end, a hole, `PROT_NONE`, two adjacent mappings) print 33
lines identical to native x86-64 and arm64. Against the run with the kernels off, on the Ryzen host
(three link orders, two rounds, 0 of 522 samples dirty), `sort -r` goes from `r` 347 to 288 (-16.9%)
on x86-64 and by 15.3% on AArch64. Alone, memcmp gives -5.7%, strcmp -6.6%, memchr -4.9% and strlen
-0.6%, which roughly add up. Shell arithmetic gains 5.0%, a SQLite index build 2.9%, awk 1.7% and
`nl` 5.2% (inside that workload's 8-12% link-order spread); the kernels-off arm's own link-order
spread is 0.5-2.5% (`nl` 9.7%). The 5.3 million recognized calls in `sort` buy about 1.3 s of 7.97
s, roughly 0.25 us each. A kernel does not pay when calls are few or operands short. glibc's
versions are ifunc variants with other bytes, so a Debian guest recognizes none.

Three changes cut dispatch. Block fusion decodes through direct jumps into one block; each block
links the two successors it last saw, so most transitions skip the block hash; and a block run 64
times is decoded again as a trace through the hot side (90% of at least 16 runs) of each branch, the
cold side a side exit. Executable memory that is unmapped or re-protected makes decoded blocks stale,
which the block cache had never checked before (code replaced at one address ran the old code). A
fault inside a trace reports the `rip` of the faulting instruction, with every register as it stood.

Link order alone moves a Katybug build by 1-4%, as much as some of the differences measured here, so
`experiments/trace-length/scripts/sweep.sh` links every build in three source orders and reports the
mean. Trace lengths share one build through `KATYBUG_SEGMENTS=n`. CPU seconds on a Ryzen 9 9900X,
one pinned core, x86-64 guests:

| arm | sqlite blocks | sqlite time | bash blocks | bash time |
| --- | --- | --- | --- | --- |
| no fusion, no links | 96.7 M | 5.68 s | 295.8 M | 18.10 s |
| links | 96.7 M | 5.37 s | 295.8 M | 16.97 s |
| fusion and links | 76.5 M | 5.20 s | 239.7 M | 16.14 s |
| traces of up to 2 blocks | 49.7 M | 5.41 s | 155.2 M | 16.83 s |
| traces of up to 8 blocks | 26.7 M | 5.23 s | 104.5 M | 16.61 s |
| traces of up to 32 blocks | 24.1 M | 5.05 s | 100.7 M | 16.39 s |

Over eight programs (sqlite, bash, awk and sort on both architectures), links save 1.4-6.8% and
fusion 3.3-5.6%. Traces cut blocks dispatched by a further 54-70%, and within the traced build time
falls with trace length and stops falling at 16 to 32 blocks, so 32 is the default. Against the
untraced build the result depends on the program: from 5.3% faster (AArch64 sort) to 2.2% slower
(x86-64 awk), 0.5% faster on average. On an Apple M-series host traces are 3.1% faster on average
and sqlite 7-8% faster. The traced build pays for its branch profile, which short traces do not win
back. Traces hold 19-80% more decoded ops.

Dispatch count does not predict time. Going from 2- to 32-block traces removes 25.6 M dispatches
and 8.8 M ops from sqlite and saves 0.36 s, 14 ns per dispatch removed, while links remove 83.7 M
block-cache lookups for 0.31 s, 3.7 ns each. The best fit of time to ops, blocks, lookups and side
exits predicts every arm within 4.2%, but only by giving blocks and side exits negative costs: the
arms differ too little for crossing costs to be read from them. Each op's own work is most of the
time: 3.2-3.8 ns an op.

So each crossing was priced alone, on a guest that varies one kind at a time, and the table was
frozen before it predicted anything. On an Apple M2 Pro (unpinned, so spread stands in for
pinning), a chained block dispatch costs 9.29 ns on an x86-64 guest and 5.26 on an AArch64 one, a
trace build's 10.54 and 5.80, a mapping slow path 7.58 and 4.42 (0.51 and 0.46 per extra mapping),
a trace side exit net of its lookup 4.61 and 10.99, and a block-cache lookup zero within error.
Predicting the four programs above from that table, with one per-op cost taken from each program's
base arm and nothing fitted, misses the 5% bound in 13 of 32 x86-64 cells (worst 11.0%, `sort` at
8-block traces) and 7 of 32 AArch64 cells (worst 6.6%); only the fusion build holds on both. Two
terms are wrong. The lookup priced at nothing saves 1.8-4.3 ns in the real programs, which hold
19,000-98,000 blocks where the microbenchmark held a handful. The trace build's block dispatch is
13.5-23.8 ns implied against 10.54 tabled, plausibly because a trace block runs 2.5-3.5 times the
ops of a chained one (not tested). The exit cost that would close the gap is 50-790 ns and changes
with the arm, so it is not a constant. The same table prices a JS call into wasm at 1.59 ns, a
wasm-to-JS import at 3.54, a wasm to JS to wasm thunk at 7.21, a burrow guest calling a host import
at 108 ns, native to burrow at 125 ns, and an awaited Durable Object to Durable Object call on
local workerd at about 300 us.

A guarded return-address stack does not pay. A decoder notes each block's calls; entering a block
pushes their return addresses onto a 64-entry stack, and a block that ends in a return compares the
popped address with the guest's `pc` and takes the block cached at that call site instead of doing
the hash lookup. A mismatch (a `longjmp`, a redirected return slot, a signal frame) searches down
the stack and then falls back to the lookup, so a return to a changed address runs what the
register says. The tests overwrite a return slot 100 times and unwind ten frames with `longjmp` 50
times, and every corpus and transcript is equal with the stack on and off. It removes 30-80% of
block-cache lookups (a bash loop of function calls: 15.3 M to 4.9 M) and moves time inside noise:
over 12 workload and architecture cells and 324 samples, on against off is -0.3 to +0.9% with a
same-setting control of -0.8 to +0.6% and link-order spread of 0.0-4.2%. Deep recursion does no
better: `fib(43)` is 2.6% slower on x86-64 and 2.0% on AArch64 although the stack removes 1.40
billion of its return lookups, and a parser about 90 frames deep moves -0.6% and +0.2%. A block
costs about 170 ns in bash, a lookup is a small part of it, and the pushes cost about what the
lookups saved. The stack was removed from Katybug after these measurements; `returns.c` stays as a
test of the interpreter's own returns, and `experiments/call-return/` keeps the rig.

Deferred flags do not pay consistently. Four settings were measured: computing every flag
(`KATYBUG_PLAN=0`), dropping the flag writes nothing reads, recording flags as an expression, and
evaluating the branch straight from the record (the default). On the Ryzen all four are within 2.4%
of each other and the default is fastest on seven of eight programs; on the Apple host dropping dead
writes alone is fastest on five of six, and the spread reaches 8.5%. Flags stay exact in signal
frames under every setting.

Neither native host is the deployed one, so both defaults were measured again with Katybug as a
guest of the wasm kernel under node 26.10 (V8): 10 arms on sqlite, bash, awk and `sort` for both
architectures, three link orders, four rounds, one output across all arms of a workload. Against
the shipped settings (fused flags, 32-block traces), geometric mean over the four workloads for
x86-64 and AArch64: no traces +4.0% and +6.0%; traces of 1 block +4.2% and +6.0%, 4 blocks +2.6%
and +2.8%, 8 blocks +1.1% and +1.0%, 16 blocks +0.1% and +0.1%, 64 blocks -0.2% and -0.1%; flags
dead-only +6.6% and +2.4%, as an expression +4.2% and +1.1%, every flag computed +1.7% and -0.9%
(the AArch64 figure is one `sort` row at 15% link-order spread). The shipped arm's link-order spread
is 0.2-2.2%, so a difference under about 2% is inside it. Traces gain more under V8 than on either
native host, the Apple host's dead-only optimum does not carry over, and computing every flag costs
only 1.7% on x86-64, which caps what carrying flags across trace boundaries could recover. Both
defaults stay.

With `KATYBUG_CACHE=<dir>`, a process writes its decoded blocks, with their profile and trace
shape, to a file named by the hash of its ELF, and the next process of that ELF takes them instead of
decoding (`persist.c`). A file is used only when Katybug's own executable, the IR's layout and the
plan settings match the ones that wrote it, and a block only while the guest bytes it was decoded
from hash the same. sqlite decodes 4,754 blocks on its first run and 104 on its second.

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

**An evicted machine's memory stays charged to its isolate.** An evicted object's next instance lands
in the same isolate every time, and a 2400-page boot there was reset 12 of 12 times, whether the
machine was aborted 0, 5 or 30 s earlier or idle-evicted 75 s earlier. A restore therefore reuses its
predecessor's memory: a module-scope pool keyed by object id holds a `WeakRef` to each machine's
memory, and `Machine` takes it when it is no larger than the machine's start size. Every restore
qualifies, since a snapshot is full size, and no boot does. A 1600-page (100 MiB) machine
checkpointed, aborted and restored exact 6 of 6 with the pool and 0 of 6 without, where the restored
machine was reset once it ran (`experiments/evicted-memory`).

**A booted object can be replaced silently between two requests.** After the first-placement burn,
a booted machine answered its next request from a new instance in another isolate, unbooted, with no
exception in the tail: 3 of 24 probe cases and 2 of 32 Lua files in one deployed run. A resident
machine survives only through its checkpoint, and the deployed rigs compare each response's instance
against the boot's and rerun a case the platform replaced.

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
in total (`experiments/event-quanta/scripts/cumulative.ts`). Keeping the first event short
therefore does not avoid the replacement; every object meets it once.

The site spends it before a machine exists (`src/worker/placement.ts`). A fresh object's first
request burns ~1.5 s of CPU, records which instance did so, and answers 503; the terminal retries.
The next request arrives on the replacement instance, which sees that another instance did the
burning and marks the object placed. Six fresh objects on Free went prime, then placed on the next
request, then kept their instance through a 1.5 s burn (`placed.ts`; priming cost 1,459-1,819 ms).
A large program's startup can then pass a second of CPU without taking the machine with it.

A host that never replaces objects (workerd under `wrangler dev`, which the Docker image runs) keeps
the priming instance. The object is marked placed once one instance has survived three burns, about
4.5 s of CPU, four times the ~1 s after which Cloudflare replaces. Before that bound every request on such a host
burned 1.5 s and answered 503, so the image could never claim a machine.

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

### WebAssembly Features

`experiments/wasm-features` compiles one module per feature at startup on Free, each in its own
`try`, so a feature the runtime lacked would fail alone. All of them compile: tail calls, branch
hints (the `metadata.code.branch_hint` section), memory64, multiple memories, relaxed SIMD and typed
function references; JSPI is present. The platform does not say which V8 it runs:
`process.versions.v8` is empty and the Node version it reports (22.19.0) is emulated.

Each feature's kernel ran against its plain form, deployed (CPU per request from `wrangler tail`, the
difference between two sizes, 13 rounds with the first dropped, medians) and under Node on a Ryzen 9
9900X core, with V8's optimizing tier and with Liftoff only. A JavaScript loop with no wasm gives
the host's speed:

| kernel, ns an op | Free | Zen 5, optimized | Zen 5, Liftoff only |
| --- | --- | --- | --- |
| JavaScript loop (no wasm) | 2.08 | 0.28 | |
| dispatch: handlers tail-call the next | 4.46 | 0.77 | 4.21 |
| dispatch: a loop over `call_indirect` | 4.92 | 0.59 | 5.35 |
| dispatch: a loop over `br_table` | 3.00 | 0.42 | 1.23 |
| hot loop, no hints | 1.39 | 0.23 | 0.55 |
| hot loop, hinted as it runs | 0.91 | 0.21 | 0.55 |
| hot loop, hinted backwards | 2.01 | 0.26 | 0.55 |
| scattered loads, wasm32 | 2.27 | 0.31 | 0.61 |
| scattered loads, memory64 | 2.08 | 0.32 | 0.64 |
| loads and page counters, one memory | 2.79 | 0.44 | 0.82 |
| loads and page counters, two memories | 3.84 | 0.43 | 0.87 |
| dot product, `mul` then `add` | 3.26 | 1.11 | 2.81 |
| dot product, relaxed `madd` | 3.41 | 1.29 | 2.99 |
| dispatch, `call_indirect` | 4.81 | 0.59 | 5.34 |
| dispatch, `call_ref` | 5.09 | 0.66 | 6.02 |

The Free host runs JavaScript 7.4 times slower than the Zen 5 core, and the wasm kernels track the
optimized column times about that factor (scattered loads 2.27 against 2.27, `br_table` 3.1 against
3.0), so deployed wasm runs optimized code. Per feature, on Free:

- A `br_table` loop dispatches fastest; threaded tail calls beat a `call_indirect` loop by 9% and run
  49% slower than `br_table`. On an Apple M-series host tail calls were fastest, so the order depends on
  the machine.
- V8 reads branch hints: with `--no-experimental-wasm-branch-hinting` the three hot loops run equal.
  Hints that match the branches ran 34% faster than none on Free and 9% on Zen 5, and the backwards
  hints 45% and 13% slower; on the Apple host the backwards hints were the fastest by 17%. A hint is a
  measured choice per host.
- memory64 costs nothing measurable, with bounds checks on trap handling.
- A second memory for interpreter metadata cost 38% on Free (26% in an earlier run), while it cost
  nothing on Zen 5 and was 12% faster on the Apple host.
- Relaxed `madd` and `call_ref` bought nothing on these kernels.

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

**Lazy restore.** Translating every guest access through a page table, a flat table in a second
memory with the lookups inlined, costs 2.06-2.66x on the census (lua 2.60, gzip 2.46, bzip2 2.67,
sqlite 2.06, sed 2.63, gawk 2.35); a 1,024-entry TLB was worse, 2.4-5.7x. Translating once per 4 KiB
page ran at 0.98-0.99x of the same loop untranslated (`experiments/mmu/src/micro.wat`). So no code
runs translated, and a restore uses the page owner table instead: it writes the pages no parked
process owns and brings a process's pages in just before one of its tasks runs. The kernel can
reach those pages for another task first: `/proc/<pid>/cmdline`, `environ` and `mem`, and ptrace, go
through `access_remote_vm`, which kernel patch 0021 has ask the host for the range before it copies.
A checkpoint of a lazily restored machine writes every page it still held back, and it zeroes the
page allocator's free pages (patch 0020 hands the host a bitmap of them), whose bytes are dead. With
two parked 6 MB processes in a 127 MiB machine (`experiments/mmu/scripts/lazy-restore.ts`), against
the same run without patches 0020 and 0021:

| | without | with |
| --- | --- | --- |
| stored image, non-zero pages | 73.6 MiB | 26.7 MiB |
| fetched at restore | 61.2 MiB | 14.4 MiB |
| free pages zeroed at checkpoint | 0 | 21,108 |
| parked processes `ps` shows with their command line | 0 of 2 | 2 of 2 |

Each parked process's 6 MB came in when it woke, intact in both runs. The restore itself made 21
reads of the image. For a second after it, with no input, the machine read nothing more; each
sleeper's wake then read its pages in whole owner runs, 21 reads at 607 KB each. Prefetching an
early working set has nothing to win here, since only parked processes' pages are held back and
each comes in at once.

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

### Write-Back Against Per-Quantum Checkpoints

`experiments/write-back/` runs an 800-page machine in 5 s quanta, one job per arm. The per-quantum
arm is what the rigs did before: every image row deleted and the whole memory written again at the
end of each quantum, then restored from those rows. The write-back arm checkpoints at the adaptive
interval, writes changed pages only, and makes every fsync durable. The write-heavy job has the
shell rewrite 16 files of about 40 KB in turn and fsync every 256th write; the CPU-heavy job is
shell arithmetic in one process. On Free, `cpuTime` from `wrangler tail`, rows counted from each
cursor's `rowsWritten`, one deploy per arm:

| job, arm | window | rows per hour | CPU per hour | per quantum | notes |
| --- | --- | --- | --- | --- | --- |
| write, write-back | 245 s, 33 quanta | 44,984 | 3,022 s | 5.6 s | 1,268 fsyncs, 30 checkpoints, 29 replaced instances restored |
| write, per quantum | 3 quanta | 40,320 | | 6.4-8.3 s | then `exceededMemory` and `exceededCpu` |
| CPU, write-back | 182 s, 14 quanta | 969 | 3,434 s | 12.4 s | 3 checkpoints, no losses |
| CPU, per quantum | 2 quanta | 40,320 | | 11.1 s | then a request that never answered |

The per-quantum arm did not survive on Free in any of four attempts: two to four quanta, then the
isolate ran out of memory or an event passed 30 s of CPU. Its rows per hour are its measured 56 rows
a quantum at 12 quanta a minute. CPU per quantum is not comparable across jobs, because a deployed
Worker's clock stands still while code runs, so a CPU-bound quantum outlasts its 5 s wall budget.

The same arms under Node, 24 quanta each with no losses, host time spent checkpointing:

| job | write-back rows per hour | per-quantum rows per hour | write-back checkpoint time | per-quantum checkpoint time |
| --- | --- | --- | --- | --- |
| write | 53,310 (1,767 fsyncs, 10 checkpoint rows) | 38,790 | 15 s an hour | 82 s an hour |
| CPU | 1,140 | 37,980 | 11 s an hour | 47 s an hour |

Checkpoint rows fall 33-130x and checkpoint time 4.5-5.4x. Exact fsync is what the write-heavy job's
rows are made of: one row per fsync of a small file, about 5 a second deployed, so it spends Free's
100,000 daily rows in about 2.2 hours. A per-quantum checkpoint makes no fsync durable at all.

On Free the write-back arm's object was replaced after nearly every event past its fourth, 29
times in 33 quanta, four of them after `exceededMemory`. Each replacement restored from the store,
wrote back the files synced since the checkpoint, and the job continued. The learned loss rate then
held the interval at one checkpoint a quantum.

Durability is exact (`experiments/write-back/scripts/fsync-exact.ts`, the asyncified kernel under
Node). The machine checkpoints; a job writes a 228,894-byte file and fsyncs it twice with a rewrite
between, writes a file it never syncs, runs a program that writes two lines to a file opened
`O_SYNC` and one that stores into a `MAP_SHARED` mapping and calls `msync(MS_SYNC)` (both
hand-written wasm in `programs/`), and writes and closes a file it never syncs. The machine is
dropped. After the restore the fsynced file has the right SHA-256, the `O_SYNC` and msynced files
hold what was written, the unsynced and the closed files are absent, the store never received the
closed file, and a file from before the checkpoint is kept. A second job writes a file, fsyncs and
removes another, and calls `sync`; after a second loss the first is there and the removed one is
not. Each control fails its own check: withholding the synced files from the restore, opening
without `O_SYNC`, or msyncing with `MS_ASYNC`. 20 of 20 runs passed after the first fix below and
8 of 8 after both.

The check found two restore defects, both older than write-back:

| defect | seen | fix | after |
| --- | --- | --- | --- |
| a task the kernel released while it still had a turn in the ready queue was left out of the snapshot, so the cpu that would have switched back to it waited forever (an RCU stall) | 4 of 15 and 4 of 20 fresh-boot restores; 2 of 20 durability runs | the snapshot keeps such a task and the ready queue by index | 0 of 260 restores, 8 of 60 had the state |
| every exited process left its parked JSPI stack, and the program instance on it, retained: V8 keeps a suspended stack as a root | JS heap +5.4 MiB every 3 s under the write job (its fsync applet forks about 15 times a second), flat for the CPU job and idle | a released task's parked stack is unwound, at the release or at its last switch | heap flat at 6-8 MiB |

The second is what reset the first deployed site with `exceededMemory` 43 s into the write job.

### The Terminal Site, Durable

`experiments/write-back/scripts/site-drive.ts` against the shipped site on Free: claim, run the
write job for 40 s on a warm socket, stop it, fsync one marker file and `sync` another, close both
sockets, leave the object to its alarms for 240 s, then reconnect and read the markers.

| phase | measured |
| --- | --- |
| attended job, 40 s | 61,184 writes, 261 file syncs, 1 `sync` walk, 2 checkpoints (16 rows for 342 changed pages, then 10 rows for 168) |
| unattended, 240 s | replaced 4 times, each restored from storage by an alarm; 10 checkpoints, 79 rows |
| whole run | 54 events, 30 of them alarms, 154.6 s CPU; no `exceededMemory` or `exceededCpu` |
| reconnect | both marker files read back |

The job ran again after the first replacement: its last checkpoint predated the stop, and a
process's state is only as durable as the last checkpoint. One alarm event early in the attended
job took 23.0 s of CPU, against the 30 s per-event limit, in this run and the one before.

Two earlier deploys failed. The first reset with `exceededMemory` (the stack retention above). In
the second, an alarm could start a checkpoint while the pump's own checkpoint was still unwinding the
same machine; the object stopped answering after 205 s. `Machine.checkpoint` now refuses a
concurrent or repeated checkpoint, and an alarm does not checkpoint while a pump runs.

### A Machine Started From an Image

`scripts/bootstrap.ts`, which `scripts/build-assets.sh` runs, boots the site's machine under Node,
runs it to its prompt (and, with `--run <line> --until <text>`, through a port's own startup),
checkpoints it, and writes the image into the Static Assets: an index, and a file for each 1 MiB of
memory that holds a nonzero byte (226 of 790 blocks of 64 KiB, 14.1 MiB in 22 files). The index
names the manifest's `image` hash, taken over the asyncified kernel, both BusyBox builds, Katybug
and the initramfs, and a site uses it only when that hash, its command line and its size all match;
otherwise it boots. A machine with nothing stored restores the image lazily, as any restore does, and
takes its own checkpoints from then on.

Every copy of an image starts with the same kernel state, so kernel patch 0023 adds `wasm_restored`,
which the host calls after every restore. It mixes 32 fresh host bytes into the entropy pool and
reseeds the crng at once, since every copy would otherwise draw the same random numbers until the
next scheduled reseed. It also resets the RCU stall and soft-lockup detectors: the host clock runs on
while a machine is stored, and a restore more than the 21 s stall timeout after its checkpoint
printed an RCU stall and a dump of every cpu (none at a 4 s gap, a stall at 36 s and at 597 s under
Node), which hung the site when it happened there. With the hook, restores 35 s, 10 minutes and 2
hours after their checkpoints ran clean.

On Free, each run against a fresh deployment:

| start | prompt, from connecting | CPU of the start |
| --- | --- | --- |
| boot | 3.2 s | about 380 ms over its first events |
| the shipped image | 1.4-1.6 s | 133 ms in one event |
| a port image: a shell whose 3,000,000-iteration startup ran at build time, parked in `read` | answered 2.2 s after the line was typed | 146 ms to restore, then turns of 2-6 ms |

The same startup run live costs about 74 s of CPU over 32 events. Started from the shipped image, it
was replaced partway by a redeploy after the machine's first checkpoint; the object came back
restored and the loop ended with its exact count. An earlier attempt was reset by the platform
itself ("Durable Object storage operation exceeded timeout") around the first checkpoint after the
image, which writes the image's pages once more (18 MB). CPython 3.8 starts in 14-35 ms of wall time
and 21-62 ms of host CPU in a machine under Node, well under the second at which a staged start
matters.

Not settled: one of five local survival runs of an image-started machine panicked ("Syscall called
when in kernel mode") right after its restore. Four more runs and every run under Node restored
cleanly, including one with the image's chunks delayed as an asset fetch delays them.

### CPU per Event

The durable site's worst event ran 23.0 s of CPU against the 30 s limit (23.3 s in a later run).
Two causes, both found on Free:

| cause | how it was found | fix |
| --- | --- | --- |
| a pump's wall budget never ended: `Date.now()` moves only at some I/O | a probe Durable Object burned 1.2 s of CPU between awaits: a storage sync that wrote caught the clock up 3 of 3 times; `setTimeout(0)`, a microtask and a sync with nothing written never did; `scheduler.wait(0..10)` did only sometimes | `Keeper.turn` caps a pump's steps as well as its wall time |
| a pump started by a warm-socket tick runs outside any awaited handler, and its CPU is charged to whichever event is open | a diagnostic deploy logged each pump's steps with the real time read after a written sync: every pump stayed within its 5 s, while one alarm event carried two pumps and 9.2 s | ticks go on the hibernatable control socket, one awaited pump per event; the warm socket only holds the object resident |

A step is one task's turn. Its cost comes from the real time the previous turn took, read at the
start of the next event, and only from a turn its step cap stopped: a turn the clock stopped may have
slept. It starts at 1 ms and moves by at most a factor of two a turn, within 500 to 12,000 steps;
the turn after a restore gets half. Under Node with the deployed clock modeled (it moves at a timer
by the timer's delay and catches up at a written sync), a shell CPU loop ran each event to the 60 s
cutoff with the wall budget alone, and 5.1 s at most with the step cap; the write job 5.2 s either
way. Deployed with both fixes, 91 events of the same drive peaked at 1.5 s of CPU.

The cap has a ceiling: a turn whose steps get k times dearer within one event runs k times its budget
before the next turn learns the new cost. The clock catches up at most such turns anyway, whenever
the job syncs a file.

It also learned from turns the clock never saw. Events that follow each other can start on the same
frozen `Date.now()`, so a step looked free and the cap doubled every turn to 12,000 steps: a shell
loop's events on Free then ran 18.4, 10.3 and 16.6 s of CPU. A turn with no elapsed time now
teaches nothing.

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

### Lanes

A lane is another Durable Object of the same deployment doing work for a machine. Deployed on Free:

| arm | result |
| --- | --- |
| one lane, SIMD sequential read (client-timed) | 27-28 GB/s at 128 MiB, 31-33 at 64 MiB, 53-62 at 16 MiB; scalar `i64` 13-17 GB/s (laptop 49, paisley-park 62) |
| plain C loops at `-O3 -msimd128`, lane / Node / native | FP32 GEMM 256^3 10-12 / 24.8 / 22.8 GFLOPS; int8 dot 7.4-9.0 / 9.3 / 59.5 GOPS; 3x3 convolution 16.8 / 36.8 / 49.7 GFLOPS |
| cold start of N lanes | one flat fan-out 0.76 s at 32 lanes to 5.19 s at 256, linear; pods of 32, 0.96-1.09 s at every size |
| aggregate read at 256 lanes | flat 0.79-1.03 TB/s with a median lane of 255-284 ms; pods of 32, 1.42-1.59 TB/s with 98-100 ms (a lone lane: 72-106 ms) |

Objects of one class share isolates: 1:1 up to 8 lanes, 204 isolates for 256. Lanes that declared
128 MiB memories were reset for the shared isolate's limit (3-118 errors a run), and 17 MiB lanes ran
256 of 256 (`experiments/lane-bandwidth`, `lane-simd`, `lane-pods`).

A connection can outlive the object that uses it when a small object of its own holds it. One held a
TLS connection to dns.google for 901 s and answered 19 DoH queries exact while its client object was
aborted or idle-evicted four times (`experiments/socket`). The request that opened the socket keeps
it, since I/O objects belong to the request that created them. Without a 60 s keepalive the
connection dropped within 300 s idle while its object stayed resident.

### Lane Placement

`experiments/lane-pods/scripts/placement.ts` places one seeded workload on 48 lanes over 40 isolates
three ways, under Node: by CPU load alone (the lane with the least recent CPU), by expected latency
and effect class, and by the same score with a prefetch plan for cold reads. The latencies are the
ones measured on Free above: a warm lane answers in ~70 ms and a cold one in ~800, a first 1 MiB
asset fetch takes 95-195 ms and a repeat ~0, and lanes in one isolate share its thread. The workload
is synthetic: 3,000 jobs, a quarter builds reading 8 chunks of one of six package sets, a quarter
authoritative writes on one of four keys, 15% external fetches that wait 150 ms without the CPU, and
small jobs reading one library chunk. The latency score adds the isolate's queue, the lane's restore
cost, the job's reads the lane does not hold, and a forward for a write off its key's owner. The
prefetch plan fetches every cold chunk of the job's trace at dispatch, up to the 50 subrequests an
event allows. Three seeds:

| scorer | job latency p50 / p99 / mean | cold-read stall mean / p99 | cold starts | writes forwarded |
| --- | --- | --- | --- | --- |
| CPU load | 230 / 2,855-2,904 / 626-637 ms | 197-201 / 1,144-1,176 ms | 48 | 713-765 |
| latency and effects | 216-230 / 2,245-2,441 / 487-512 ms | 20-21 / 450-509 ms | 6-7 | 0 |
| latency, effects and prefetch | 193-230 / 2,075-2,310 / 480-519 ms | 6-7 / 98-114 ms | 5-7 | 0 |

The CPU scorer spreads work over every lane, so each one starts cold once and loses what the last
lane read; the latency score keeps jobs where their data and their key live. The prefetch plan cuts
cold-read stalls by another factor of three and moves the mean by up to 1.5%, since a build's CPU
already overlaps most of its reads.

### The Interpreted Tier

Wasm that arrives at run time runs on burrow's wasm3, itself compiled to wasm. Seven integer kernels
with no imports (`experiments/interp-topology/src/guests.c`) ran on V8 directly, on burrow's shipped
`wasm3.wasm`, and on Katybug's IR interpreter through its wasm frontend built with emscripten, and
both interpreters also ran as native builds (clang; wasm3 with burrow's pin, patches and fusion
catalog). paisley-park, one kernel per physical core, time at 2n less time at n, median of 3:

| kernel | V8 | wasm3, hosted | wasm3, native | Katybug, hosted | Katybug, native |
| --- | --- | --- | --- | --- | --- |
| chain (dependent multiply-add) | 10.2 ms | 4.2x | 3.4x | 232x | 87x |
| crc32 | 24.2 ms | 5.6x | 2.8x | 184x | 87x |
| sort | 31.0 ms | 8.3x | 4.2x | 208x | 87x |
| sieve | 17.5 ms | 12.5x | 7.2x | 485x | 196x |
| fib | 17.8 ms | 23.3x | 9.5x | 430x | 166x |
| matmul | 3.8 ms | 33.1x | 21.0x | 1,056x | 417x |
| sha256 | 35.3 ms | 54.9x | 16.2x | 817x | 363x |

Hosting costs wasm3 1.23-3.40x over its native build and Katybug 2.12-2.67x, so wasm3's tail-called
handlers lose no more on V8 than a `switch` loop does (sha256 is the exception). Katybug's wasm
frontend keeps a function's locals in guest memory behind inline caches, which puts it 15-55x behind
wasm3; it is a correctness frontend, not a candidate cold tier.

What promotion to native code buys was measured on zlib 1.3.1's deflate
(`experiments/promotion-ladder`). A counted copy run in V8 gives each function's dynamic instructions
per deflate, the stand-in for its interpreted time: `longest_match` 74.0%, `deflate_slow` 13.3%,
`fill_window` 5.0%, `compress_block` 3.0%, `zmemcpy` 3.0%, `adler32_z` 1.6%. A promoted function runs
natively over wasm3's own memory, every load and store at the guest's base plus the address, with
the stack pointer passed on entry. wasm3 cannot be re-entered from a host call, so a function goes
native only once every function it calls has, which fixes the rungs:

| promoted share | `r` against V8 | Amdahl | crossings per deflate |
| --- | --- | --- | --- |
| none | 13.24 | 13.24 | 0 |
| 74.0% (`longest_match`) | 7.10 | 4.25 | 91,105 |
| 77.0% | 6.29 | 3.88 | 91,108 |
| 80.0% | 5.97 | 3.52 | 91,143 |
| 81.5% | 5.85 | 3.33 | 91,161 |
| 86.7% (`fill_window` and its callees) | 5.18 | 2.71 | 91,190 |
| 100% (`deflate_slow` and its callees) | 1.08 | 1.09 | 14 |

Amdahl holds when the boundary is cold and misses by 1.6-1.9x when it is crossed 91,000 times a
deflate, about 0.5 us per crossing through JavaScript. No rung lies between 86.7% and 100%:
`deflate_slow` goes native only together with the functions it calls. The ladder ran alone on one
core under Node 26.10 (V8 14.6). Under Node 24.21 (V8 13.6) V8's own deflate is as fast, but the
fully interpreted run takes 37% longer (`r` 18.36) and the 74.0% rung 16% longer (8.33), and a
crossing still costs about 0.5 us. On an Apple M-series laptop the same ladder runs at 7.40 interpreted and
0.97 promoted.

A planner picks the cut over the call graph (`experiments/promotion-cut`). It takes the dynamic call
graph (indirect calls counted where they ran), a cost per crossing and a code budget in bytes, and
chooses the native set that minimizes interpreted work left plus native work plus crossings on cut
edges. Run on zlib, bzip2 1.0.8 and zstd 1.5.6 (freestanding wasm32 rebuilds of 32, 22 and 265
functions; none has a mutually recursive cluster) against three simpler policies, on an Apple M2 Pro
(5 rounds, 2 repeats, median spread of an `r` 3%, at most 11%): min-cut is never worse than
promoting the hottest function beyond the spread, and is the only policy that finds a set at bzip2's
tightest budget, though there the gain (12.80 against 13.17 all interpreted) is inside the spread at
the other crossing cost. Caller-with-callees closure is worse on zstd (`r` 5.22 against 1.68 at a
10% budget), and cutting at strongly connected components equals hottest. The crossings a run makes
equal the predicted count in all 96 measured rows. Under a byte budget min-cut is a heuristic, since
the problem contains knapsack; with no budget it equals enumeration on 200 random graphs. zstd's
`i64` and float functions cannot cross burrow's `i32` imports, so 22 of its 265 functions (3.64% of
its instructions) stay interpreted, and `r` is 1.65 at the largest budget against 1.10 fully native.

The crossing cost is the number the planner leans on, and it reads three ways. The isolated
native-to-burrow thunk costs 125 ns on the M2 Pro (149-195 ns at the guest's argument count, 100-138
on a pinned Ryzen 9 9900X); one more crossing inside a run costs 188-246 ns on the Mac and 155-212
on the Ryzen; and the promotion rungs' residuals fit 253-354 ns on the Mac (271-346 for zlib and
zstd) and 213-351 on the Ryzen. Priced at 125 ns the model predicts crossing-heavy sets 16-22% too
fast; priced at the fit it is within about 7%. The JavaScript glue is at most about 10 ns of it;
argument count and the crossing inside a run explain most of the rest, and a body that thrashes the
cache between crossings adds only 1-15%. In a Durable Object on Free the same thunk costs 455, 466,
656 and 860 ns at 2, 3, 5 and 7 arguments, 3.0-4.4 times the Mac. A plain Worker on Free hit error
1102 above about 50,000 crossings, so the deployed loop runs in a Durable Object.

A profile takes 12.6-16.6 s to make and about 1 ms to load (`experiments/profile-cache`). A record
per guest, keyed by the module's SHA-256, holds the call graph, the ladder's two end timings, the
plan and target sets and the mined fusion catalog. It is used only while its provenance (format,
burrow version, wasm3 pin, a hash of burrow's interpreter sources, a hash of the scripts that write
it, the planner's arguments) is current, and changing any of nine burrow key inputs refuses it. Cold
pipeline against cached load, median of three (spread): zlib 16,575 ms (2%) against 1.1 ms, bzip2
16,139 ms (2%) against 1.0 ms, zstd 12,587 ms (1%) against 1.7 ms, 7,356 to 15,908 times. Timing
the two ends and mining the catalog is 87-97% of a cold profile. Every cached file equals the cold
run's byte for byte, and the plan derived again from the cached graph equals the cached plan. What
is left of a restart is rebuilding the promoted rungs from the cached sets, 228-747 ms.

A wasm-to-wasm planner (constant propagation and folding, branch pruning, unreachable code, dead
locals, fixed globals, unused blocks and functions) is exact and has nothing to do on compiler
output. On zlib, bzip2 and zstd at -O2 it removes 0 of 13,246, 31,066 and 202,075 instructions,
since clang has already done that work. At -O0 it removes 3.38, 8.94 and 0.57% of static and 8.07,
7.90 and 1.01% of dynamic instructions, and `r` under wasm3 moves by 0.974-1.007 against a 0.2-8.6%
spread (the same module run twice differs by up to 1.8%). It is exact by checksum under V8 and wasm3
on nine guests, with each transform alone and on 400 random programs, and two mutants (branch depths
not retargeted, locals not cleared at `end`) fail its tests. What -O0 costs is stack-slot loads and
stores, which the planner does not touch.

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

gmux's own build steps are TypeScript (the module passes, the syscall adapters, the pins) and C (the
module reader), with no Python. They run under bun, or node where there is no bun, or in a
`node:26-bookworm-slim` container on a host with neither. The initramfs is gzipped with fflate at
level 9 and mtime 0, which writes the same bytes on every host; this changed `initramfs.bin`'s
compressed bytes once, and its cpio is the same.

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
| after a restore the host calls `wasm_restored`: fresh host bytes reseed the crng, and the RCU stall and soft-lockup detectors reset | every copy of one checkpoint drew the same random numbers, and a restore more than 21 s after its checkpoint printed an RCU stall |
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

`scripts/kernel/unbuilt-syscalls.ts` lists the syscall numbers whose table entry is still
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
`scripts/wasm-imports.c`, a small C tool cc-strict builds with the host `cc`, reads imports and
exports, because the toolchain's `llvm-nm` and `llvm-objdump` cannot parse the final modules.
`main(void)`, `main(argc, argv)` and `main(argc, argv, envp)` programs built this way all run in a
booted kernel.

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

### fork

A program built with resumable frames forks. The child gets a memory of its own holding a copy of
the parent's mappings (kernel patch 0015, musl patch 0008), and the parent's frames, spilled once,
resume in both. `tests/c/fork.c` (a fork 40 frames deep, a pipe, fork then exec, a forking server
whose handlers fork from a fork child) passes in Node and deployed on Free; dash and `make -j2` pass
in Node. The copy is eager rather than copy-on-write, and a forked child cannot share memory with
other processes.

### dlopen

`src/gmux/dl.c` sends a library's bytes to the host (`src/worker/machine/dl.ts`), which instantiates
the precompiled side module registered under their hash into the calling process: data in memory the
process allocated, functions on its table, imports from the program's exports. zlib 1.3.1 built with
`-shared` loads through `dlopen` and prints what the same program prints natively against the same
zlib (`tests/c/dl.c`), in Node and deployed on Free. An unregistered library is refused with the
reason, since a Worker cannot compile code at run time, and so are ELF objects and executables.
Threads created after `dlopen` see the library, and snapshots carry it.

### Stacks

A process starts on a 128 KiB stack and grows in 1 MiB segments up to `RLIMIT_STACK`, where an
overflow is `SIGSEGV` instead of a write into the heap below. Each frame allocation is checked by one
unsigned compare, which costs 2.4% on gawk, 1.8% on sed and nothing measurable on Lua (11 rounds); a
first form that checked every stack pointer write cost up to 7.6%.

### Syscall Dispatch

linux-wasm dispatched a syscall by casting the handler to a function of as many arguments as
userspace passed, and wasm's `call_indirect` traps unless the types match. musl's `pause()` is
`ppoll` with four of its five arguments; its futex calls pass three or four of six; each trapped in
the kernel. `arch/wasm/kernel/syscall_adapters.c` is generated by `scripts/kernel/syscall-adapters.ts`
from the preprocessed syscall table and a built kernel: a handler's real type comes from the binary,
not its prototype, because `SYSCALL_DEFINE`'s alias leaves only `__se_sys_x` in a wasm build, an
unbuilt syscall is `sys_ni_syscall`, and wasm32's `rt_sigreturn` takes no arguments whatever
`syscalls.h` declares. Seven call shapes cover all 319 table entries. The adapters reference no
`sys_*` symbol, so rebuilding with them changes no handler's type; `scripts/kernel/adapters-check.sh`
regenerates after a config change until the file is a fixed point.

### Path-Query Cache

With `MachineOptions.syscallCache`, a statx of an absolute path can be answered by the host without
entering the kernel. The syscall router asks a plain host import first, which hashes the path in
place and returns the stored answer when the kernel's path-query generation and the task's view are
what they were; otherwise the call goes through the hook to the kernel, and the answer is kept.
Kernel patch 0022 gives both. `wasm_fs_gen` counts every mtime and ctime store, every atime that
changes and every size change of a file, directory or symlink on the root filesystem, every change
to the mount tree and every chroot. `wasm_fs_view` is the task's root dentry when its lookups depend
on nothing but the path: it may search every directory, resolves in the first mount namespace and
has its root on that filesystem. The host keeps success, ENOENT and ENOTDIR only, never an answer
about a device, fifo or socket, and never one whose lookup ended off the root mount (a proc or sysfs
answer changes with no timestamp moving). A hit skips the kernel's syscall entry, so a signal pending
for the task waits for its next real syscall or fuel yield.

Each rule answers a case the check below caught:

| generation first counted | what it missed or cost |
| --- | --- |
| every timestamp store, any filesystem | a shell loop kept 0 answers: the console and `/dev/null` move their times at every write |
| root filesystem only | device nodes live on the root filesystem here, with the same effect |
| file, directory and symlink stores only | 651 invalidations in 200 `ls -l`: relatime stores an unchanged atime while it is not newer than the ctime |
| atime only when it changes | a write in the same clock tick as the last grows a file with no time stored: a stale size (the check failed, 1 mismatch) |
| plus every size change | exact |

`experiments/syscall-cost/scripts/cache.ts` runs a mutation script with the cache off, on, and in
verify mode, which asks the kernel every time and compares with what the cache holds: create, write
in one tick, chmod twice in one tick, rename, remove, symlink, mkdir over a removed file, a tmpfs
mounted over a directory and removed, and `/proc` paths. The transcripts are byte for byte equal, and
94,030 verified answers had 0 mismatches.

| measure (this Mac, Node) | kernel | cache |
| --- | --- | --- |
| `stat` of one path in a loop (`cost.ts`) | 166 ns | 110 ns, 59,997 hits in 60,022 calls |
| `ls -l /bin`, 1,000 times | 484-497 µs each | 499-530 µs each, 87,000-88,000 hits and 6,200-6,800 refills |

A hit saves ~56 ns; a miss goes through the Suspending hook and costs several microseconds, so the
cache pays only above roughly 50 hits a miss. The kernel's own statx of a cached dentry is already
cheap, and `ls -l` still invalidates everything about 70 times in 1,000 runs for a reason not yet
found. The option stays off.

### Threads

Pthreads never worked on linux-wasm. Its variadic `__clone` read the TLS and clear-tid arguments only
under `CLONE_CHILD_SETTID`, and `pthread_create` passes `CLONE_SETTLS | CLONE_CHILD_CLEARTID` without
it: every thread started with `pthread_self()` = 0 and no clear-tid address, `pthread_join` never
woke, and the last worker's exit ended the process with status 0, which read as success. The musl
patch in `src/musl/patches/` reads each argument its flags use. Four threads counting 40,000 times
under a mutex and a condition variable, with `join`, are exact in a booted kernel.

libc-test's 24 pthread tests pass 20 on Free. The other four needed `fork` or a real `PROT_NONE`
when they were run, which was before `fork` landed. Six musl and kernel defects were fixed on the
way: per-thread TLS, the `siginfo` offset, cancellation points, the `ucontext_t` layout,
detached-thread exit, and signals to a spinning thread.

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
are a signature mismatch in typed wasm, so under fatal warnings every such probe fails.

`EXTRA_CFLAGS=-msimd128` builds the same set with autovectorization (217 to 3,047 SIMD instructions
per program). Against the plain build, 5 rounds, arms interleaved: Lua 1.020, gzip 0.992, bzip2
0.991, sqlite 0.986, sed 0.987, gawk 0.997, inside the ~3% noise, at 0.1-2.8% more bytes. For
scalar programs a SIMD build buys nothing; SIMD pays where a kernel is written for it.

### Upstream Suites

`tests/suites/lua.sh` builds the same Lua 5.4.7 source with musl on a native Linux host and runs its
suite file by file there and in gmux, then prints both columns. gmux passes 30 of 32 on Free and
native musl 29 of 32, and the two agree on 31 files: `big` and `literals` fail on both, and
`heavy.lua` fails natively under the container's 2 GB cap. The suite found three defects on the way:
the 128 KiB stack overflowing into the heap, a wall clock stuck in 1970, and a missing `/tmp`.
libc-test's pthread suite is under Threads.

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
| `src/worker/durable.ts`, `src/worker/schedule.ts`, `src/worker/keeper.ts`, `src/worker/machine/router.ts` | write-back checkpoints and exact file syncs in SQLite; the adaptive interval and the one alarm; the site's restore, checkpoint and wake policy; the syscall router that hands the sync calls to the host |
| `src/worker/site-machine.ts`, `src/worker/bootstrap.ts`, `scripts/bootstrap.ts` | the site's machine options, shared by the site and the image builder; the bootstrap image's format and lazy reader; the build step that takes the image |
| `src/rootfs/` | files the pipeline lays over linux-wasm's initramfs (`/init`, the `binfmt_misc` registrations) |
| `scripts/build-linux.sh`, `scripts/build-kernel.sh` | the reproducible pipeline (in Docker on a Linux host), and the step that stages its output into `build/` |
| `scripts/cc-strict`, `scripts/wasm-imports.c` | the strict CC for user programs, and its module reader |
| `scripts/ts`, `scripts/pin.ts` | runs a build script under bun or node, and prints one pin from `src/sources.json` |
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
| `experiments/evacuation/`, `mmu/` | resumable frames (`evacuate.ts`) and the control-flow checkpoint matrix; the software MMU bench and lazy restore |
| `experiments/console-interrupt/`, `syscall-cost/` | host calls and input latency of the console; host time per syscall |
| `experiments/exec-stubs/` | guest memory, exec time and image size with full executables against stubs in the rootfs |
| `experiments/write-back/` | per-quantum checkpoints against write-back on Free and under Node, the durability check (fsync, `O_SYNC`, `msync`, close, `sync`), the keeper under Node, and the deployed site's restore drive |
| `scripts/tail.ts`, `scripts/probe.ts` | the `wrangler tail` parser and the gate drivers' shared client |
| `scripts/census.sh`, `docker/census.Dockerfile` | the package census, and its image (the toolchain with node, wabt, pkg-config and unzip) |
| `scripts/wasm/config.site`, `toolchain.cmake`, `target-run.ts`, `target/` | autoconf answers for the target, a CMake toolchain file, and running a configure's test programs on gmux (`GMUX_TARGET_RUN`, ssh and scp for perl) |
| `scripts/kernel/unbuilt-syscalls.ts`, `adapters-into-patch.sh` | the syscalls a build leaves unbuilt, and regenerated syscall adapters put into patch 0004 |
| `experiments/katybug-profile/` | Katybug against native x86-64: timings, a CPU profile by phase, and Katybug built per flag set (`variants.sh`) |
| `experiments/aot-oracle/` | hot blocks lifted to C and compiled into Katybug, attached by exact IR match; native attribution arms |
| `experiments/interp-topology/`, `promotion-ladder/` | wasm3 against Katybug's IR interpreter, hosted and native; zlib with its hottest functions promoted to native code |

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
(`scripts/build-linux.sh <new dir>`, then `scripts/build-kernel.sh <dir>/out`). CI does the second on
every push: `build.yml` runs the pipeline from source with the LLVM toolchain cached by its pins,
stages the result, uploads it as the `gmux-build` artifact, and the probes, the snapshot package and
the dev image all use that artifact (`bun run hydrate --from=payload/gmux-build.tar.gz`).
`build.lock.json` pins the payload a cut release ships. Then:

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
