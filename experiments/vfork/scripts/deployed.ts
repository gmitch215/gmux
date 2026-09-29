// on a deployed Free machine: BusyBox $(...) through gmux's vfork, and a C program's vfork
const B = process.env.WORKER_URL;
if (!B) throw new Error('set WORKER_URL to the deployed worker, e.g. https://<name>.<subdomain>.workers.dev');
const cases = [
	['$(...)', 'echo A=$(echo hi) C=$(echo $(echo nested)) D=`echo back`; echo END-$((1+1))', (o) => o.includes('A=hi C=nested D=back')],
	['vfork: execve, _exit, failed execve', 'vf; echo END-$((1+1))', (o) => o.includes('from-exec') && o.includes('second exited 7') && o.includes('third exited 9')]
];
let failed = 0;
for (const [label, cmd, check] of cases) {
	const name = `vfork-${Date.now()}`;
	const get = async (path) => (await fetch(`${B}${path}${path.includes('?') ? '&' : '?'}do=${name}`)).json().catch(() => ({}));
	await get('/burn?iters=3e8');
	await get('/boot?pages=800&wall=20000');
	let out = (await get(`/exec?cmd=${encodeURIComponent(cmd)}&wall=6000`)).out ?? '';
	for (let i = 0; i < 6 && !out.includes('END-2'); i++) out += (await get('/run?until=END-2&wall=5000')).out ?? '';
	const ok = check(out);
	if (!ok) failed++;
	console.log(ok ? 'PASS' : 'FAIL', label.padEnd(36), ok ? '' : JSON.stringify(out.slice(-200)));
}
process.exit(failed ? 1 : 0);
