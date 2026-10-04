import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Machine } from '../../../src/worker/machine/machine.ts';

/**
 * BusyBox httpd and wget over the guest's own `lo`: pump steps, host-call counters and wall time
 * for a 6.9 MB file at a given MTU. `MTU=1500 node --experimental-strip-types
 * experiments/serving/scripts/lo.ts [kernel dir]`; MODE=tcpsvd serves through tcpsvd, MODE=inetd
 * through inetd
 */
const root = new URL('../../../', import.meta.url).pathname;
const dir = process.argv[2] ?? join(root, 'build/kernel');
const mtu = process.env.MTU ?? '65536';
const mode = process.env.MODE ?? 'standalone';
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
let output = '';
const machine = new Machine({
	vmlinux: new WebAssembly.Module(readFileSync(join(dir, 'vmlinux.wasm'))),
	initrd: new Uint8Array(readFileSync(join(dir, 'initramfs.bin'))),
	cmdline: 'maxcpus=3 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0',
	registry: new Map([
		[manifest.busybox, new WebAssembly.Module(readFileSync(join(dir, 'busybox.wasm')))]
	]),
	maximumPages: 4096,
	sha256: (bytes) => createHash('sha256').update(bytes).digest('hex'),
	sharedKernel: true,
	write: (text) => (output += text)
});
let steps = 0;
// an idle machine's next timer is reached without waiting, so the wall time is the guest's work
const sleep = async (_ms: number) => {};
const run = (until: () => boolean, limitMs = 300_000) => {
	const started = Date.now();
	return machine.run(() => (steps++, until() || Date.now() - started > limitMs), sleep);
};
const marker = (name: string) => `${name}-${Math.floor(Math.random() * 1e6)}`;
async function sh(command: string) {
	const done = marker('done');
	const from = output.length;
	machine.type(`${command}; echo ${done.replace('-', '=')}-$?\n`);
	const want = done.replace('-', '=');
	await run(() => new RegExp(`${want}-\\d`).test(output.slice(from)));
	return output.slice(from).replace(/\r/g, '');
}

await run(() => output.includes('# '));
await sh('ifconfig lo 127.0.0.1 up');
await sh(`ifconfig lo mtu ${mtu}`);
await sh('mkdir -p /www/cgi-bin; seq 1 1000000 > /www/big.txt; ls -l /www/big.txt');
if (mode === 'standalone') await sh('httpd -f -p 8080 -h /www > /tmp/httpd.log 2>&1 &');
else if (mode === 'tcpsvd')
	await sh('tcpsvd -E 127.0.0.1 8080 httpd -i -h /www > /tmp/httpd.log 2>&1 &');
else {
	await sh('echo "8080 stream tcp nowait root /bin/httpd httpd -i -h /www" > /tmp/inetd.conf');
	await sh('inetd -f /tmp/inetd.conf > /tmp/httpd.log 2>&1 &');
}
await sh('sleep 1');
const before = { ...machine.stats };
const stepsBefore = steps;
const started = process.hrtime.bigint();
const timed = await sh('wget -q -O /dev/null http://127.0.0.1:8080/big.txt; echo wget-rc=$?');
const ms = Number(process.hrtime.bigint() - started) / 1e6;
const after = { ...machine.stats };
const out =
	timed +
	(await sh('wget -q -O /tmp/got http://127.0.0.1:8080/big.txt; ls -l /tmp/got; cmp /tmp/got /www/big.txt && echo same'));
const delta = (key: keyof typeof after) => Number(after[key]) - Number(before[key]);
console.log(
	JSON.stringify({
		mode,
		mtu,
		kernel: dir,
		steps: steps - stepsBefore,
		wallMs: +ms.toFixed(1),
		switches: delta('switches'),
		idles: delta('idles'),
		userCopies: delta('userCopies'),
		reply: out.split('\n').filter((l) => /wget-rc|same|got/.test(l)),
		log: (await sh('cat /tmp/httpd.log | head -5')).split('\n').slice(0, 6),
		crashed: String(machine.crashed)
	})
);
process.exit(0);
