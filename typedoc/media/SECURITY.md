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
- **A non-root process can write only its own memory and shared mappings.** The kernel keeps an owner
  for every page. A non-root process runs a build of its program that checks every store against
  that table and ends the process with `SIGSEGV` on a refused one, and the kernel refuses its syscall
  buffers outside its own pages with `EFAULT`. A non-root process cannot run a program that has no
  such build.
- **Reads are not isolated.** Any process can read the kernel's memory and every other process's.
- **Shared memory is shared with every non-root process.** A page a process maps shared and writable
  (`MAP_SHARED`, System V shared memory) can be written by any non-root process in the machine.

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
address and the process's tag, both read-only, and `__gmux_denied`, which ends the process.

`dlopen` loads only side modules whose bytes hash to a module compiled with the build; other files
are refused, since a Worker cannot compile code at run time.

The kernel imports the host's driver functions: task switching, idle waits, the console, the clock,
random bytes and executable loading. They take kernel pointers into the machine's own memory and
act only on that memory and that machine's host state.

## Threat Matrix

| threat                                                                        | status                                                                                                         |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| a non-root process alters the kernel or another process in the same machine   | refused: every store and syscall buffer is checked against the kernel's page owner table                       |
| a non-root process writes memory another process maps shared                  | possible                                                                                                       |
| a process reads the kernel or another process in the same machine             | possible; reads are not isolated                                                                               |
| a root process alters the kernel or another process                           | possible; root is trusted with the machine                                                                     |
| a process loads code the build did not compile                                | refused: `dlopen` and `exec` take only registered modules; a refused `exec` ends the process with `SIGSEGV`    |
| a process reaches a Worker binding, secret or Durable Object storage directly | refused: no import exposes them                                                                                |
| a process reads another machine's memory                                      | refused: separate memories, no shared host state                                                               |
| a process instantiates a module with an unlisted import                       | refused at link time and at instantiation                                                                      |
| a visitor opens the terminal without the owner token                          | refused                                                                                                        |
| a process exhausts its machine's CPU or memory                                | bounded by fuel, invocation quanta and the machine's memory maximum; the machine, not the deployment, degrades |
| a process escapes the V8 WebAssembly sandbox                                  | out of scope for gmux; report it to the engine's maintainers                                                   |
| timing side channels between machines                                         | not addressed                                                                                                  |
