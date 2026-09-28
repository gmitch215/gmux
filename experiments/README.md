# Experiments

Each directory here answers one question about running Linux inside a Cloudflare Durable Object:
what the platform allows, how much a design slows things down, or whether a mechanism gets the exact
right answer. Most hold a probe Worker (`src/`, `wrangler.jsonc`), a `build.sh` for inputs that are
not committed, and drivers under `scripts/`. Some run only under Node against the kernel in
`build/`, and some run natively on a Linux x86-64 host to get a reference answer.

The numbers below are summaries. The full tables, with hosts, runs and spreads, are in
[TECHNICAL_REPORT.md](../TECHNICAL_REPORT.md).

## Units and Terms

| term | meaning |
| --- | --- |
| ns, us, ms, s | nanoseconds, microseconds, milliseconds, seconds. `us` is microseconds (millionths of a second); the files are plain ASCII, so it is not written with the Greek letter mu |
| KiB, MiB, GiB | powers of two: 1 MiB is 1,048,576 bytes |
| KB, MB, GB, TB | powers of ten: 1 MB is 1,000,000 bytes, about 5% less than 1 MiB |
| GB/s, TB/s | bytes read per second |
| GFLOPS, GOPS | billions of floating-point (or integer) operations per second |
| Nx, N times slower | the time taken divided by the time of the thing it is compared with; 1.00x is the same speed, 2x takes twice as long, 0.95x is 5% faster |
| `r` | the same, against the program running natively on the same machine: `r` = 100 means 100 times slower than native |
| Durable Object, object | one Cloudflare Worker instance with its own storage; a gmux machine lives in one |
| isolate | the V8 sandbox an object runs in; several objects of one class can share one, and its memory |
| event | one request, message or alarm handled by an object; Cloudflare limits the CPU of each |
| quantum, quanta | a slice of CPU time the machine runs in one event before it pauses and waits for the next (quanta is the plural) |
| first placement | the one time Cloudflare moves a new object to another machine, after about its first second of CPU |
| lane | another Durable Object of the same deployment doing work for a machine |
| checkpoint, restore | saving the whole machine to storage, and starting it again from that save |
| rows | SQLite rows written to the object's storage; the Free plan allows 100,000 a day |
| exact | the output is byte for byte the same as a reference run's |
| Free | measured on a deployed Worker on the Workers Free plan. CPU there comes from `cpuTime` in `wrangler tail`, since a deployed Worker's clock stands still while code runs |
| Node | measured locally under Node, which runs the same V8 engine as Cloudflare |
| census | six real programs built for gmux (Lua, gzip, bzip2, sqlite, sed, gawk) used as a benchmark |

## Running a Rig

Deployed rigs need a Cloudflare account and `wrangler`. Deploy the folder's Worker, run its driver
against the URL it prints, then delete the Worker. Rigs that boot the real kernel need `build/`
(`bun run hydrate`, or the pipeline in `scripts/build-linux.sh`), and several need the boot rig
staged first:

```sh
experiments/boot/scripts/stage.sh
node --experimental-strip-types experiments/<name>/scripts/<driver>.ts
```

Each driver's header comment gives its arguments.

## Platform Limits

| directory | what it measures | result | notes |
| --- | --- | --- | --- |
| `object-memory/` | how much memory one object may hold before the platform resets it | about 195 MiB in total; a single wasm memory stops at 128 MiB | the 195 MiB is shared by everything: the machine's memory, its wasm instances and its paused tasks |
| `stack-depth/` | the deepest recursion that returns, called directly and on a JSPI stack | | a probe for the stack limits the other rigs build on |
| `event-quanta/` | CPU per event, first placement, and how far a loop gets per safepoint | a new object is moved once, after about 1 s of CPU counted across events; an event is stopped between 25 and 35 s of CPU | keeping the first event short does not avoid the move, so the site spends that second before it boots a machine |
| `residency/` | how long an idle object keeps its paused tasks in memory, by what keeps it alive | a normal WebSocket keeps them past 30 minutes; a hibernating WebSocket or an alarm loses them within 15 s | anything that must last longer than that has to be checkpointed to storage |
| `publication/` | deploying a new version while machines are running | every object in memory restarts; an object already evicted wakes on the new version with its storage intact | a deploy is a restart for every live machine, so machines checkpoint first |
| `codegen/` | compiling wasm when the Worker starts, from compressed bytes | 54.5 MB of wasm compiles at startup in 715 ms; compiling after startup is refused | a Worker cannot compile code on demand, so every program a machine can run is compiled at startup |
| `wasm-features/` | which newer wasm features the deployed runtime supports, and what each changes | all compile: tail calls, branch hints, memory64, multiple memories, relaxed SIMD, typed function references | see below |
| `network/` | outbound sockets | plain TCP and TLS to public hosts work, including SMTP with STARTTLS | connections to Cloudflare's own addresses are refused |
| `assets/` | reading files from the deployment's static assets inside an object | 95-195 ms for a first read up to 1 MiB, about 0 ms when repeated | each read counts against the 50 outbound requests an event may make |
| `evicted-memory/` | whether an evicted object's memory still counts against its isolate | it does, every time; restoring into the old memory worked 6 of 6 times, into a fresh allocation 0 of 6 | the fresh allocation pushed the isolate over its memory limit, so restores reuse the old memory |

The wasm features were timed per operation on Free and on one core of a Ryzen 9 9900X. Plain
JavaScript runs 7.4 times slower on Free than on that core, and the wasm kernels are slower by about
the same factor, so deployed wasm is fully optimized, not interpreted. Branch hints that match the
code made a loop 34% faster on Free; a second wasm memory for bookkeeping made one 38% slower. Which
choice wins depends on the machine: a `br_table` loop was the fastest dispatch on Free and threaded
tail calls on an Apple M-series laptop.

## Pausing and Events

| directory | what it measures | result | notes |
| --- | --- | --- | --- |
| `jspi-parks/` | pausing and resuming wasm tasks through JSPI | about 1.3 us per pause and resume; 20,000 tasks paused at once all resume exact | JSPI lets a wasm call wait without blocking the object's single thread. Each paused task of 1,025 frames uses 10-14 KiB of memory. Also holds the toy kernel and process the other probes import |
| `baton/` | where a job with no terminal attached gets its next event | two objects passing a WebSocket message ran 1,000 quanta and wrote no rows; an alarm per quantum ran them in 148 s against 76-82 s; a chain of requests stops at 8 | the request chain stops because Cloudflare limits how many requests deep a chain can go |
| `quanta-job/` | a CPU-heavy job across many events, and process counts, on the boot rig | | drivers only, run against the boot rig's Worker |
| `socket/` | holding one outbound connection in an object of its own | one TLS connection stayed open 901 s and answered 19 DNS queries exact while the object using it was evicted four times | a connection belongs to the request that opened it, so a small separate object keeps it alive |
| `console-interrupt/` | what typing into the console costs the host | an idle minute went from 139 host checks to 0, and a typed command from 1,044 ms of machine time to 0 | the kernel used to poll the console; now the console raises an interrupt when input arrives |

## The Booted Machine

| directory | what it measures | result | notes |
| --- | --- | --- | --- |
| `boot/` | the kernel host's Worker, the Node boot script and the stage script other rigs use | boots to a BusyBox prompt in 476 ms of CPU (median of 31 boots, 299-799) | |
| `shell/` | pipes, a blocked reader, `^C`, a busy loop and background jobs on a deployed machine | 5 of 5 | each case runs on a fresh machine |
| `vfork/` | the shell's `$(...)` and a C program's `vfork` on a deployed machine | `execve`, `_exit` and a failed `execve` each return the right status | wasm cannot return from a function twice, which `vfork` normally needs; gmux runs the child on the parent's stack instead |
| `posix/` | a signal handler that blocks, threads, sockets, file locks, `eventfd`, `epoll`, `timerfd`, `inotify` and `/dev/null` | all pass on Free | "a signal handler that blocks" is one that calls something like `sleep` or `read` while handling a signal. That needs the handler to pause mid-call, so each handler gets its own JSPI stack |
| `setjmp/` | Lua's error handling, then its own test suite file by file, on a deployed machine | 30 of 32 files pass, against 29 of 32 for the same source on native Linux with musl | the two agree on 31 files: `big` and `literals` fail on native Linux too, so they test the C library, not gmux. The native run also fails `heavy.lua` because its container is capped at 2 GB |
| `instances/` | what one wasm instance per process costs | removing unused exports and sizing tables cut a BusyBox process from 820-907 KiB of JS heap to 31 KiB | fifty processes went from 70.6 to 11.7 MiB |
| `exec-stubs/` | the root filesystem holding full programs, against small stubs that point to a precompiled copy | the initramfs shrank from 750 KB to 5 KB compressed; 300 fork and exec pairs went from 568-828 ms to 152-243 ms | the host already holds every program compiled, so the filesystem only needs to name it |
| `syscall-cost/` | host time per system call, how often programs read the clock, and a host-side cache for `statx` | `getpid` 25 ns, `stat` 161 ns, open, read and close 321 ns | the cache gave the right answer 94,030 times out of 94,030, but a hit saves only 56 ns and a miss costs microseconds, so it stays off |

## Checkpoints and Durability

| directory | what it measures | result | notes |
| --- | --- | --- | --- |
| `sparse-checkpoints/` | ways to checkpoint a 64 MiB machine | saving only changed pages: 7 ms and 2 rows when 5% changed, against 301 ms and 34 rows for the whole memory | compression made it 8 times slower for a 4x smaller write |
| `dirty-tracking/` | finding which pages changed | hashing each 64 KiB page at checkpoint takes 126 ms per 64 MiB; marking pages on every write made a write-heavy loop 34-44% slower | hashing costs nothing between checkpoints, so it is the default |
| `machine-checkpoint/` | the whole booted kernel checkpointed in the middle of a job, evicted and restored | exact on Free: a 1 GiB pipeline 3 of 3, a background job 2 of 2, an idle shell 4 of 4 | the restored shell answers and the job finishes with the right checksum |
| `evacuation/` | resumable frames in user programs in place of Asyncify, and a matrix of places a checkpoint can land | census programs run at most 9% slower than a plain build; Asyncify made a CPU-heavy pipeline 63% slower | recursion, `setjmp`, callbacks, signal handlers, a loaded library, Lua inside a coroutine and x86-64 bash under Katybug all restore exact |
| `mmu/` | a software MMU, a process in its own memory, checked memory access, and lazy restore | translating every memory access made programs 2.06-2.66 times slower; checking every load and store for a non-root process 1.26-2.86 times slower | a restore now loads each paused process's pages only when it next runs, and fetched 14.4 MiB instead of 61.2. A process in its own memory computes at full speed, and its system calls that copy buffers are slower |
| `write-back/` | writing back changed pages against rewriting the whole image every quantum, and whether `fsync` survives a lost machine | 33-130 times fewer checkpoint rows | files saved with `fsync`, `O_SYNC`, `msync` or `sync` come back after a lost machine, and unsaved files do not, as on Linux. The shipped site restored itself from storage four times in 240 s with nobody connected |
| `staged-init/` | starting the site from a machine image shipped in its assets | a prompt in 1.4-1.6 s, against 3.2 s booting | a startup that takes 74 s of CPU live restores in 146 ms from an image taken after it |

## Lanes

| directory | what it measures | result | notes |
| --- | --- | --- | --- |
| `lane-bandwidth/` | how fast one lane reads its own memory | 27-28 GB/s with SIMD over 128 MiB, 53-62 GB/s over 16 MiB | smaller buffers fit in the CPU cache |
| `lane-simd/` | plain C loops built with SIMD, in a lane, in Node and natively | single-precision matrix multiply at 10-12 GFLOPS in a lane, 24.8 in Node, 22.8 natively | a lane runs these loops at about half of Node's speed |
| `lane-pods/` | starting, reading and placing work across many lanes | pods of 32 lanes start in about 1 s at any size up to 256 lanes and read 1.42-1.59 TB/s together | placing work by expected latency cut the mean job time from 626-637 ms to 487-512 ms in a simulated workload |

Objects of one class share isolates: one each up to 8 lanes, 204 isolates for 256.

## Foreign Programs and Interpreters

Katybug runs unmodified x86-64 and AArch64 Linux programs inside the machine by interpreting them.

| directory | what it measures | result | notes |
| --- | --- | --- | --- |
| `katybug-profile/` | Katybug against native x86-64, and where its time goes | 99 (`factor`) to 331 (`bash`) times slower than native | 64-93% of the time is the loop that picks the next instruction. Removing four small costs from that loop made it 13-27% faster |
| `trace-length/` | joining blocks of guest code, linking them, and following hot paths (traces) of each length | links made programs 1.4-6.8% faster and joining blocks 3.3-5.6%; traces ran anywhere from 5.3% faster to 2.2% slower | the order files are linked in changes a build's speed by 1-4% on its own, so each build is linked three ways and averaged |
| `aot-oracle/` | how fast Katybug could get by turning the hottest code into C ahead of time | the translated code runs 9-29 times slower than native in the machine, and 5-25 times slower even compiled natively | wasm adds little; the way guest code is represented is most of the cost. Checking for signals at loop back-edges and after each system call stays exact and made one program 18.6% faster |
| `interp-topology/` | wasm3 against Katybug's wasm frontend, each run inside wasm and natively | running inside wasm makes wasm3 1.23-3.40 times slower and Katybug 2.12-2.67 times slower | Katybug's wasm frontend is 15-55 times slower than wasm3; it exists to check correctness, not for speed |
| `promotion-ladder/` | zlib compression with its hottest functions made native while wasm3 interprets the rest | 13.24 times slower than V8 fully interpreted, 7.10 with the hottest function native, 1.08 with everything native | each call between native code and the interpreter costs about 0.5 us, which is why the middle steps gain less than their share of the work |
| `cut-model/` | a model of run time as work in each mode plus the cost of each crossing, checked against the two rigs above | predicts the zlib ladder within 5.5% | on the trace sweep it fits within 4.2% only by giving some costs negative values, so those runs differ too little to measure crossing costs from |
