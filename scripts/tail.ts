import { readFileSync } from 'node:fs';

const path = process.argv[2] ?? '/tmp/gmux-gates/tail.jsonl';
const filter = process.argv[3] ?? '';
const text = readFileSync(path, 'utf8');

// wrangler tail --format json prints one pretty-printed object after another
const events: any[] = [];
let depth = 0;
let start = -1;
let inString = false;
for (let i = 0; i < text.length; i++) {
	const ch = text[i];
	if (inString) {
		if (ch === '\\') i++;
		else if (ch === '"') inString = false;
		continue;
	}
	if (ch === '"') inString = true;
	else if (ch === '{') {
		if (depth === 0) start = i;
		depth++;
	} else if (ch === '}') {
		depth--;
		if (depth === 0 && start >= 0) {
			events.push(JSON.parse(text.slice(start, i + 1)));
			start = -1;
		}
	}
}

for (const e of events) {
	const req = e.event?.request;
	const label = req
		? new URL(req.url).pathname + new URL(req.url).search
		: (e.event?.type ?? Object.keys(e.event ?? {}).join(','));
	if (filter && !label.includes(filter) && e.entrypoint !== filter) continue;
	console.log(
		[
			e.eventTimestamp,
			e.executionModel,
			e.entrypoint ?? '-',
			e.outcome,
			`cpu=${e.cpuTime}`,
			`wall=${e.wallTime}`,
			label
		].join('\t')
	);
}
