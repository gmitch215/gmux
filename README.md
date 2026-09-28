<div style="display: flex; align-items: center; flex-direction: column;" align="center">
    <img align="center" style="align-self: center; max-width: 256px" src="https://cdn.gmitch215.xyz/gmux.png" width="30%" alt="" />
    <h1 style="text-align: center;">gmux</h1>
    <p style="text-align: center;">Linux on Serverless</p>
    <div align="center">
        <img src="https://img.shields.io/github/v/release/gmitch215/gmux">
        <img src="https://img.shields.io/github/downloads/gmitch215/gmux/total">
        <img src="https://img.shields.io/github/license/gmitch215/gmux">
        <img src="https://img.shields.io/github/stars/gmitch215/gmux?style=flat">
        <img src="https://img.shields.io/github/commit-activity/t/gmitch215/gmux?color=violet">
    </div>
</div>

---

A real Linux kernel, compiled to WebAssembly, running inside one Cloudflare Worker. Each machine is a
Durable Object with a BusyBox userland and a browser terminal.

## 📋 Table of Contents

- [🎯 Why gmux](#-why-gmux)
- [🚀 Quick Start](#-quick-start)
- [📥 Install the Library](#-install-the-library)
- [🐧 What Runs](#-what-runs)
- [🧱 How It Works](#-how-it-works)
- [🔒 Security](#-security)
- [🛠️ Building from Source](#️-building-from-source)
- [📚 Documentation](#-documentation)
- [📄 License](#-license)

## 🎯 Why gmux

Serverless platforms run functions, not machines. gmux runs the machine: Linux 7.0 boots to a shell
inside a Durable Object, and ordinary Linux programs run on it unmodified, with processes, pipes,
job control, signals, threads, sockets, `fork` and `dlopen`. A job that needs more CPU than one
event allows continues across events. The host can turn a running machine into bytes
(`Machine.checkpoint`) and resume it exactly in a fresh isolate (`Machine.restore`).

## 🚀 Quick Start

Run a machine locally with Docker:

```sh
docker run --rm -p 8787:8787 ghcr.io/gmitch215/gmux
```

Open `http://localhost:8787/_gmux/term`, claim the machine, and you are at a root shell. The container's
`/var/lib/gmux` volume holds the machine's Durable Object storage.

Deploy your own to Cloudflare:

```sh
git clone https://github.com/gmitch215/gmux && cd gmux
bun install --ignore-scripts
bun run hydrate              # the released kernel build
bash scripts/build-assets.sh # the terminal page
bunx wrangler deploy
```

The first visitor to `/_gmux/term` claims the machine and receives its owner token.

## 📥 Install the Library

The machine host is an npm package with the kernel, BusyBox, Katybug and the initramfs inside it:

```sh
bun add @gmitch215/gmux
```

```ts
import { createHash } from 'node:crypto';
import { Machine } from '@gmitch215/gmux';
import manifest from '@gmitch215/gmux/kernel/manifest.json';
import vmlinux from '@gmitch215/gmux/kernel/vmlinux.wasm';
import busybox from '@gmitch215/gmux/kernel/busybox.wasm';
import initrd from '@gmitch215/gmux/kernel/initramfs.bin';

const machine = new Machine({
  vmlinux,
  initrd: new Uint8Array(initrd),
  cmdline: 'maxcpus=3 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc',
  registry: new Map([[manifest.busybox, busybox]]),
  sharedKernel: true,
  sha256: (bytes) => createHash('sha256').update(bytes).digest('hex'),
  write: (text) => console.log(text)
});
machine.type('uname -a\n');
const started = Date.now();
await machine.run(
  () => Date.now() - started > 5_000,
  (ms) => new Promise((resolve) => setTimeout(resolve, ms))
);
```

The host runs in a Durable Object, workerd, or Node with JSPI (`WebAssembly.Suspending`). In a Worker,
`.wasm` imports compile at deploy time, which is the only place a Worker may compile code.

## 🐧 What Runs

|                  |                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| Userland         | BusyBox, with an interactive shell, pipelines and job control                                    |
| Processes        | `fork`, `vfork`, `execve`, pthreads, signals with handlers that block                            |
| System           | sockets (Unix and loopback TCP), `epoll`, `eventfd`, `timerfd`, `inotify`, `flock`, System V IPC |
| Libraries        | `dlopen` of wasm side modules shipped with the deployment                                        |
| Foreign binaries | unchanged x86-64 and AArch64 Linux ELFs, through Katybug                                         |

Programs are compiled for `wasm32-linux` with `scripts/cc-strict`, which refuses any import outside
the syscall surface. Code that arrives at run time cannot be compiled on Workers, so every native
executable is built with the deployment.

## 🧱 How It Works

The kernel and every process share one WebAssembly memory. A syscall is a direct call from the
program's instance into the kernel's. Blocking is JSPI: every task that waits is a suspended wasm
stack, and one pump on the Durable Object's single thread resumes exactly the task the kernel
schedules next. When a machine has to leave memory, its parked stacks become bytes (Asyncify for the
kernel, resumable frames or Asyncify for programs), and a restore rewinds them into fresh instances.

Katybug decodes x86-64 and AArch64 into gmux's IR and interprets it, turning guest syscalls into the
machine's own. `binfmt_misc` hands it any foreign ELF, so `execve` of an amd64 binary just works.

[TECHNICAL_REPORT.md](TECHNICAL_REPORT.md) has the design, the platform limits that shape it, and
what each operation costs.

## 🔒 Security

A machine is a Durable Object: code inside it has no Worker bindings, secrets or network authority
beyond what the host passes to it, and a deployed Worker cannot compile code at run time. Inside one
machine, root processes share one trust domain; non-root processes cannot write memory they do not
own, but they can read it. [SECURITY.md](SECURITY.md) has the trust model, the import surface and the
threat matrix.

## 🛠️ Building from Source

The kernel, musl, BusyBox and Katybug build reproducibly on a Linux host with Docker from the pins in
`src/sources.json` and the patches under `src/`:

```sh
scripts/build-linux.sh ~/gmux-build      # the toolchain, kernel, libc, userland and probes
scripts/build-kernel.sh ~/gmux-build/out # staged into build/
bun run test:probes                      # C probes booted in a machine
```

Two clean builds produce the same bytes in every artifact. The probes refuse a `build/kernel`
staged from other pins or patches than the tree's.

```sh
bun run typecheck
bun run test
bun run format:check
```

## 📚 Documentation

- [Technical report](TECHNICAL_REPORT.md): architecture, platform constraints, measured costs
- [Security](SECURITY.md): trust model and threat matrix
- [TypeScript API](https://gmux.gmitch215.dev/typedoc/) and [C reference](https://gmux.gmitch215.dev/doxygen/)

## 📄 License

gmux is GPL-3.0-only. The kernel and its patches are GPL-2.0-only (`LICENSES/`), BusyBox is
GPL-2.0-only, and musl is MIT.
