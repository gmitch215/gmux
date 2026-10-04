import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * copies the staged kernel (build/kernel, from scripts/build-kernel.sh or `bun run hydrate`) into
 * dist/kernel for the package, refusing a partial set
 */
const root = new URL('..', import.meta.url).pathname;
const from = join(root, 'build/kernel');
const to = join(root, 'dist/kernel');
export const KERNEL_FILES = [
	'vmlinux.wasm',
	'busybox.wasm',
	'busybox.share.wasm',
	'busybox.guard.wasm',
	'katybug.wasm',
	'initramfs.bin',
	'manifest.json'
];

// MachineOptions.router, built by scripts/build-router.sh
export const ROUTER_FILES = ['router.wasm', 'statx.wasm'];
const router = join(root, 'build/router');

const missing = KERNEL_FILES.filter((name) => !existsSync(join(from, name)));
if (missing.length) {
	console.error(
		`build/kernel lacks ${missing.join(', ')}: run \`bun run hydrate\` or scripts/build-kernel.sh first`
	);
	process.exit(1);
}
const unbuilt = ROUTER_FILES.filter((name) => !existsSync(join(router, name)));
if (unbuilt.length) {
	console.error(`build/router lacks ${unbuilt.join(', ')}: run scripts/build-router.sh first`);
	process.exit(1);
}
mkdirSync(to, { recursive: true });
for (const name of KERNEL_FILES) copyFileSync(join(from, name), join(to, name));
for (const name of ROUTER_FILES) copyFileSync(join(router, name), join(to, name));
// the sources the binaries came from, for their GPL obligations
writeFileSync(
	join(to, 'SOURCES.md'),
	`# Kernel Artifacts

Built by \`scripts/build-linux.sh\` from the pins in \`src/sources.json\` with the patches in
\`src/kernel/patches\`, \`src/musl/patches\` and \`src/busybox/patches\`, all shipped in this package.
The kernel is GPL-2.0-only and BusyBox GPL-2.0-only (\`LICENSES/\`); musl is MIT. \`router.wasm\` and
\`statx.wasm\` are built by \`scripts/build-router.sh\` from \`src/gmux/core/router\`.

| file | sha256 |
| --- | --- |
${[...KERNEL_FILES, ...ROUTER_FILES].map((name) => `| \`${name}\` | ${sha256(join(to, name))} |`).join('\n')}
`
);
console.log(`dist/kernel: ${KERNEL_FILES.length + ROUTER_FILES.length} files`);

function sha256(path: string): string {
	return new Bun.CryptoHasher('sha256').update(readFileSync(path)).digest('hex');
}
