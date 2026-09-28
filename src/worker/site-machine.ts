import type { MachineOptions } from './machine/machine.ts';

// no nohz_full: its timekeeping cpu never stops ticking, and its context tracking reads the host
// clock on every syscall
export const CMDLINE =
	'maxcpus=3 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0';
export const MAXIMUM_PAGES = 800;

/** the staged build/kernel the site's machine is made of */
export interface SiteBuild {
	vmlinux: WebAssembly.Module;
	busybox: WebAssembly.Module;
	busyboxGuard: WebAssembly.Module;
	katybug: WebAssembly.Module;
	initrd: Uint8Array;
	manifest: { busybox: string; katybug: string; image?: string };
}

/**
 * the site's machine options, which scripts/bootstrap.ts boots with too, so a bootstrap image is
 * taken from the machine the site runs
 */
export function siteOptions(
	build: SiteBuild,
	host: Pick<MachineOptions, 'sha256' | 'write' | 'memory'>
): MachineOptions {
	return {
		vmlinux: build.vmlinux,
		initrd: build.initrd,
		cmdline: CMDLINE,
		registry: new Map([
			[build.manifest.busybox, build.busybox],
			[build.manifest.katybug, build.katybug]
		]),
		// a non-root task's BusyBox checks every store against the kernel's page owner table
		guarded: new Map([[build.manifest.busybox, build.busyboxGuard]]),
		maximumPages: MAXIMUM_PAGES,
		sharedKernel: true,
		asyncify: true,
		...host
	};
}
