/**
 * The gmux machine host: runs the Linux kernel compiled to WebAssembly on one host thread, in a
 * Cloudflare Durable Object, workerd or Node. The kernel, BusyBox, Katybug and the initramfs ship in
 * this package under `kernel/`.
 *
 * @example
 * ```ts
 * import { createHash } from 'node:crypto';
 * import { Machine } from '@gmitch215/gmux';
 * import manifest from '@gmitch215/gmux/kernel/manifest.json';
 * import vmlinux from '@gmitch215/gmux/kernel/vmlinux.wasm';
 * import busybox from '@gmitch215/gmux/kernel/busybox.wasm';
 * import initrd from '@gmitch215/gmux/kernel/initramfs.bin';
 *
 * const machine = new Machine({
 * 	vmlinux,
 * 	initrd: new Uint8Array(initrd),
 * 	cmdline: 'maxcpus=3 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc',
 * 	registry: new Map([[manifest.busybox, busybox]]),
 * 	sharedKernel: true,
 * 	sha256: (bytes) => createHash('sha256').update(bytes).digest('hex'),
 * 	write: (text) => console.log(text)
 * });
 * machine.type('uname -a\n');
 * const started = Date.now();
 * await machine.run(
 * 	() => Date.now() - started > 5_000,
 * 	(ms) => new Promise((resolve) => setTimeout(resolve, ms))
 * );
 * ```
 *
 * @module
 */
export { dylinkInfo } from './worker/machine/dl.ts';
export type { DlSaved, DylinkInfo, Slot } from './worker/machine/dl.ts';
export { Machine, stubHash } from './worker/machine/machine.ts';
export type {
	Entry,
	HandlerStacks,
	MachineOptions,
	MachineStats,
	SavedRunner,
	Snapshot
} from './worker/machine/machine.ts';
export { compileRouter } from './worker/machine/router.ts';
export type { RouterModules } from './worker/machine/router.ts';
