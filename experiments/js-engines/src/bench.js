// deterministic engine workload; prints checksums only, so every engine's output must match
const emit = typeof print === 'function' ? print : console.log;

function fib(n) {
	return n < 2 ? n : fib(n - 1) + fib(n - 2);
}

const M = 1000000007;

emit('fib27 ' + fib(27));

const a = new Array(200000);
for (let i = 0; i < a.length; i++) a[i] = i;
const mapped = a.map((x) => (x * 2654435761) % 1000003);
emit('map ' + mapped.length + ' ' + mapped[199999]);

const sorted = mapped.slice().sort((x, y) => x - y);
emit('sort ' + sorted[0] + ' ' + sorted[100000] + ' ' + sorted[199999]);

emit('reduce ' + sorted.reduce((s, x) => (s + x) % M, 0));

const rows = [];
for (let i = 0; i < 20000; i++) {
	rows.push({ id: i, name: 'row' + i, v: [i, i * 3, i % 7], ok: (i & 1) === 0 });
}
const json = JSON.stringify(rows);
const back = JSON.parse(json);
emit('json ' + json.length + ' ' + back.length + ' ' + back[19999].name + ' ' + back[7].v[2]);

let s = '';
for (let i = 0; i < 100000; i++) s += String.fromCharCode(97 + (i % 26));
emit('string ' + s.length + ' ' + s.charCodeAt(12345));

let hits = 0;
for (const m of s.repeat(4).matchAll(/([a-c])d+e/g)) hits += m.index % 3 + 1;
emit('regexp ' + hits);
