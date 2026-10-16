import type { MachineOptions } from './machine/machine.ts';
import type { HostRuntime } from './machine/router.ts';

// no nohz_full: its timekeeping cpu never stops ticking, and its context tracking reads the host
// clock on every syscall
export const CMDLINE =
	'maxcpus=3 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0';
export const MAXIMUM_PAGES = 800;

/** the port the machine's site listens on, and how long a request may wait for the machine to speak, ms */
export const PUBLIC_PORT = 80;
export const SERVE_LIMIT_MS = 30_000;
/** requests held open at once, and the largest request body, bytes; more get a 503 and a 413 */
export const MAX_OPEN_STREAMS = 20;
export const MAX_REQUEST_BYTES = 256 << 20;
/** how long a finished stream waits for the next request, ms; under lighttpd's own 5 s keep-alive idle */
export const IDLE_STREAM_MS = 3000;
/** how long an open stream may go without its client reading, ms; past it the stream is closed and its slot freed */
export const STALLED_STREAM_MS = 30_000;

/** the staged build/kernel the site's machine is made of */
export interface SiteBuild {
	vmlinux: WebAssembly.Module;
	busybox: WebAssembly.Module;
	busyboxGuard: WebAssembly.Module;
	/**
	 * the share build of BusyBox (scripts/wasm/share.ts), registered in place of `busybox` so a
	 * finished process's instance is reused for the next exec. It has no asyncify frames, so a
	 * checkpoint is refused while any process of it lives (and it forks by vfork, and cannot
	 * dlopen): a machine that checkpoints on a schedule, as the site does, leaves this unset
	 */
	busyboxShare?: WebAssembly.Module;
	katybug: WebAssembly.Module;
	/** build/router: the router the keeper's file syncs go through, the statx hit path and the core */
	runtime: HostRuntime;
	initrd: Uint8Array;
	manifest: { busybox: string; katybug: string; image?: string };
}

/**
 * the site's machine options, which scripts/bootstrap.ts boots with too, so a bootstrap image is
 * taken from the machine the site runs
 */
export function siteOptions(
	build: SiteBuild,
	host: Pick<MachineOptions, 'sha256' | 'digest' | 'write' | 'memory'>
): MachineOptions {
	return {
		vmlinux: build.vmlinux,
		initrd: build.initrd,
		cmdline: CMDLINE,
		registry: new Map([
			[build.manifest.busybox, build.busyboxShare ?? build.busybox],
			[build.manifest.katybug, build.katybug]
		]),
		// a non-root task's BusyBox checks every store against the kernel's page owner table
		guarded: new Map([[build.manifest.busybox, build.busyboxGuard]]),
		runtime: build.runtime,
		maximumPages: MAXIMUM_PAGES,
		sharedKernel: true,
		asyncify: true,
		...host
	};
}
