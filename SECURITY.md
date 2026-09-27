# Security

## Reporting a Vulnerability

Report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/gmitch215/gmux/security/advisories/new), not in
public issues. Include the gmux version, the host (Cloudflare Free, Paid, or self-hosted workerd),
and the steps that reproduce it.

## Trust Model

A gmux machine is one Linux kernel and its processes inside one Durable Object. The kernel and every
process share one WebAssembly linear memory, and WebAssembly gives no protection inside a memory, so
gmux enforces isolation itself:

- **Root is trusted with the machine.** A process with effective uid 0 can read and write the
  kernel's memory and every other process's.
- **A non-root process can reach only its own memory and the shared mappings it maps.** The kernel
  keeps an owner for every page: a process's tag for its private pages, a region's tag for a shared
  mapping (`MAP_SHARED`, System V shared memory, a file mapped read-only), and for each process the
  regions it maps and whether it may write them. A non-root process runs a build of its program that
  checks every load and store against that table and ends the process with `SIGSEGV` on a refused
  one, and the kernel refuses its syscall buffers outside its own pages and its regions with
  `EFAULT`. A non-root process cannot run a program that has no such build.
- **Past 4,095 shared regions at once**, a new shared mapping is open to every process.

Run only software you trust with the whole machine as root, and do not keep secrets in a machine
that runs code you do not trust.

Between a machine and everything outside it:

| boundary                        | what enforces it                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| guest and the Worker's bindings | guest code reaches the host only through the imports listed below; no import exposes `env`, storage, network clients or other objects |
| one machine and another         | each machine has its own `WebAssembly.Memory` and host state; guest code has no reference to another machine's                        |
| guest and the terminal          | the terminal requires the owner token, claimed once at first run and stored as a SHA-256 hash, compared in constant time              |
| guest and the host engine       | the V8 WebAssembly sandbox                                                                                                            |

## The Import Surface

User programs may import only the kernel's syscall entry points (`__wasm_syscall_0` to
`__wasm_syscall_6`), their memory and table, `__gmux_fuel` (a scheduling yield), `__gmux_vfork`,
`__gmux_vfork_exec` and `__gmux_vfork_exit`, `__gmux_dlprep`, `__gmux_dlopen`, `__gmux_dlsym`,
`__gmux_dlclose` and `__gmux_dlerror` (`dlopen` of side modules the build registered), and
`__wasm_abort`. `scripts/cc-strict` refuses to link a program that imports anything else, and the
host refuses to instantiate one. The builds non-root processes run also import the page owner table's
address, the process's tag and the address of its region set, all read-only, and `__gmux_denied`,
which ends the process.

`dlopen` loads only side modules whose bytes hash to a module compiled with the build; other files
are refused, since a Worker cannot compile code at run time.

The kernel imports the host's driver functions: task switching, idle waits, the console, the clock,
random bytes and executable loading. They take kernel pointers into the machine's own memory and
act only on that memory and that machine's host state.

## Threat Matrix

| threat                                                                        | status                                                                                                         |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| a non-root process alters the kernel or another process in the same machine   | refused: every store and syscall buffer is checked against the kernel's page owner table                       |
| a non-root process reads the kernel or another process in the same machine    | refused: every load is checked against the same table                                                          |
| a non-root process reaches memory another process maps shared                 | refused unless it maps the same segment or file itself                                                         |
| a non-root process keeps reaching a page after it is unmapped or detached     | refused: the next load or store faults, whether it was parked in a syscall or at a fuel yield                  |
| a non-root process writes a region it mapped read-only, through a syscall     | possible: syscall buffers are checked for access to the region, not for its write permission                   |
| a root process alters the kernel or another process                           | possible; root is trusted with the machine                                                                     |
| a process loads code the build did not compile                                | refused: `dlopen` and `exec` take only registered modules; a refused `exec` ends the process with `SIGSEGV`    |
| a process reaches a Worker binding, secret or Durable Object storage directly | refused: no import exposes them                                                                                |
| a process reads another machine's memory                                      | refused: separate memories, no shared host state                                                               |
| a process instantiates a module with an unlisted import                       | refused at link time and at instantiation                                                                      |
| a visitor opens the terminal without the owner token                          | refused                                                                                                        |
| a process exhausts its machine's CPU or memory                                | bounded by fuel, invocation quanta and the machine's memory maximum; the machine, not the deployment, degrades |
| a process escapes the V8 WebAssembly sandbox                                  | out of scope for gmux; report it to the engine's maintainers                                                   |
| timing side channels between machines                                         | not addressed                                                                                                  |
