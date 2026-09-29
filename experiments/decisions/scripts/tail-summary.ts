import { readFileSync } from 'node:fs';

/**
 * Summarises a `wrangler tail --format json` log of one worker: its alarm events (wall and cpu per
 * event, restored or not from the `restored` log line) and its request and websocket events, in
 * the window FROM..TO (epoch ms of each event's `eventTimestamp`).
 * `FROM=... TO=... node --no-warnings --experimental-strip-types experiments/decisions/scripts/tail-summary.ts <tail.jsonl>`
 */
const text = readFileSync(process.argv[2] ?? '', 'utf8');
const time = (value: string | undefined, fallback: number) => (value ? (/^\d+$/.test(value) ? Number(value) : Date.parse(value)) : fallback);
const from = time(process.env.FROM, 0);
const to = time(process.env.TO, Infinity);

interface Tail {
	wallTime: number;
	cpuTime: number;
	eventTimestamp: number;
	outcome: string;
	logs: { message: string[] }[];
	event?: { scheduledTime?: string; request?: unknown; getWebSocketEvent?: unknown };
}
const events: Tail[] = [];
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
	} else if (ch === '}' && --depth === 0 && start >= 0) {
		events.push(JSON.parse(text.slice(start, i + 1)));
		start = -1;
	}
}

const inWindow = events.filter((e) => e.eventTimestamp >= from && e.eventTimestamp <= to);
const alarms = inWindow.filter((e) => e.event?.scheduledTime);
const others = inWindow.length - alarms.length;
const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
const at = (xs: number[], p: number) => sorted(xs)[Math.floor(p * (xs.length - 1))];
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const logged = (e: Tail, key: string) =>
	e.logs.some((l) => l.message.some((m) => m.includes(`"gmux":"${key}"`)));
const restored = alarms.filter((e) => logged(e, 'restored'));
const wall = alarms.map((e) => e.wallTime);
const cpu = alarms.map((e) => e.cpuTime);
const span = alarms.length > 1 ? (alarms.at(-1)!.eventTimestamp - alarms[0]!.eventTimestamp) / 1000 : 0;
console.log(
	JSON.stringify({
		alarmEvents: alarms.length,
		restoredAlarmEvents: restored.length,
		otherEvents: others,
		spanSeconds: Math.round(span),
		intervalSeconds: alarms.length > 1 ? Math.round((span / (alarms.length - 1)) * 10) / 10 : null,
		wallMs: { mean: mean(wall), p50: at(wall, 0.5), p90: at(wall, 0.9), max: Math.max(...wall) },
		cpuMs: { mean: mean(cpu), p50: at(cpu, 0.5), max: Math.max(...cpu) },
		wallMsRestored: mean(restored.map((e) => e.wallTime)),
		wallMsNotRestored: mean(alarms.filter((e) => !restored.includes(e)).map((e) => e.wallTime)),
		gbSeconds: (wall.reduce((a, b) => a + b, 0) / 1000) * 0.128,
		outcomes: [...new Set(alarms.map((e) => e.outcome))]
	})
);
