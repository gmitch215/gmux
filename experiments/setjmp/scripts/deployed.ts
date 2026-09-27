// on a deployed Free machine: Lua's error handling, then its test suite file by file (_port=true)
const B = process.env.G08_URL ?? 'https://gmux-boot.gmitch215-free.workers.dev';
const name = `setjmp-${Date.now()}`;
const get = async (path) => (await fetch(`${B}${path}${path.includes('?') ? '&' : '?'}do=${name}`)).json().catch(() => ({}));
const until = async (cmd, marker, rounds = 60) => {
	let out = (await get(`/exec?cmd=${encodeURIComponent(cmd)}&wall=8000`)).out ?? '';
	for (let i = 0; i < rounds && !out.includes(marker); i++) out += (await get(`/run?until=${marker}&wall=8000`)).out ?? '';
	return out;
};
await get('/burn?iters=3e8');
await get(`/boot?pages=${process.env.PAGES ?? 1200}&wall=20000`);
const basic = await until(
	`lua -e "print(pcall(error, 'boom')); print(pcall(function() return coroutine.resume(coroutine.create(function() error('x') end)) end))"; echo END-$((1+1))`,
	'END-2'
);
console.log(basic.includes('false\tboom') && basic.includes('true\tfalse') ? 'PASS' : 'FAIL', 'pcall and coroutine errors', JSON.stringify(basic.slice(-160)));
const files = process.argv.slice(2);
const suite = await until(
	`cd /lua-tests; for f in ${files.length ? files.join(' ') : '*.lua'}; do [ $f = all.lua ] && continue; if lua -e "_port=true" $f > /dev/null 2>&1; then echo "PASS $f"; else echo "FAIL $f"; fi; done; echo END-$((1+1))`,
	'END-2',
	200
);
for (const line of suite.split(/\r?\n/)) if (/^(PASS|FAIL) /.test(line)) console.log(line);
process.exit(0);
