/**
 * Lane placement scored by CPU load alone, against a score of expected latency and effect class,
 * and with a prefetch plan for cold reads, over one seeded workload under Node. The latencies are
 * the ones measured on Free (TECHNICAL_REPORT, Lanes and Asset Fetches; results/free-*.jsonl); the
 * workload is synthetic and named below. No deploy: the question is which lane each scorer picks and
 * what that costs, not the platform.
 * `node --experimental-strip-types experiments/lane-pods/scripts/placement.ts [seed]`
 */

// measured on Free: a warm lane answers a dispatch in ~70 ms (32 lanes, warm phase, 70-162), a cold
// one in ~800 (765-853); a first ASSETS.fetch of a 1 MiB chunk 95-195 ms, a repeat ~0; lanes that
// share an isolate share its one thread (64 lanes landed on 61 isolates)
const WARM_MS = 70;
const COLD_MS = 800;
const FETCH_COLD_MS = [95, 195] as const;
const FETCH_WARM_MS = 1;
const FORWARD_MS = 30;
// an object idle this long is evicted: the site's control socket saw it at 70 s
const EVICT_MS = 70_000;
const LANES = 48;
const ISOLATES = 40;
const JOBS = 3000;
// the per-event subrequest limit caps how many cold reads a prefetch plan issues at once
const PREFETCH_MAX = 50;

type Effect = 'pure' | 'authoritative' | 'external';
interface Job {
	at: number;
	kind: string;
	cpuMs: number;
	effect: Effect;
	key?: number;
	waitMs: number;
	/** the chunks the job reads, each at the CPU offset it needs it: its syscall trace */
	reads: { chunk: string; atMs: number }[];
}
interface Lane {
	id: number;
	isolate: number;
	busyUntil: number;
	lastUsed: number;
	resident: Set<string>;
	cpuLoad: number;
}

function rng(seed: number) {
	let s = seed >>> 0 || 1;
	return () => {
		s ^= s << 13;
		s ^= s >>> 17;
		s ^= s << 5;
		return (s >>> 0) / 2 ** 32;
	};
}

/**
 * the workload: builds (pure, 0.2-2 s of CPU, 8 chunks of one of six package sets), database writes
 * (authoritative on one of four keys, 20-100 ms, two chunks of their table), fetches (external:
 * 10 ms of CPU around 150 ms of waiting) and small pure jobs (5-50 ms, one chunk)
 */
function workload(seed: number): Job[] {
	const r = rng(seed);
	const jobs: Job[] = [];
	let at = 0;
	for (let i = 0; i < JOBS; i++) {
		at += -Math.log(1 - r()) * 200;
		const p = r();
		if (p < 0.25) {
			const set = Math.floor(r() * 6);
			const cpuMs = 200 + r() * 1800;
			const reads = Array.from({ length: 8 }, (_, k) => ({
				chunk: `pkg${set}/${Math.floor(r() * 20)}`,
				atMs: (k / 8) * cpuMs
			}));
			jobs.push({ at, kind: 'build', cpuMs, effect: 'pure', waitMs: 0, reads });
		} else if (p < 0.5) {
			const key = Math.floor(r() * 4);
			const cpuMs = 20 + r() * 80;
			const reads = [0, 1].map((k) => ({ chunk: `db${key}/${k}`, atMs: (k / 2) * cpuMs }));
			jobs.push({ at, kind: 'db', cpuMs, effect: 'authoritative', key, waitMs: 0, reads });
		} else if (p < 0.65) {
			jobs.push({ at, kind: 'fetch', cpuMs: 10, effect: 'external', waitMs: 150, reads: [] });
		} else {
			const cpuMs = 5 + r() * 45;
			const reads = [{ chunk: `lib/${Math.floor(r() * 30)}`, atMs: 0 }];
			jobs.push({ at, kind: 'small', cpuMs, effect: 'pure', waitMs: 0, reads });
		}
	}
	return jobs;
}

const fresh = (): Lane[] =>
	Array.from({ length: LANES }, (_, id) => ({
		id,
		isolate: id % ISOLATES,
		busyUntil: 0,
		lastUsed: -Infinity,
		resident: new Set(),
		cpuLoad: 0
	}));

/** when a lane can start: its own queue and every isolate-mate's, which hold the same thread */
const readyAt = (lanes: Lane[], lane: Lane, now: number) =>
	Math.max(now, ...lanes.filter((l) => l.isolate === lane.isolate).map((l) => l.busyUntil));
const warm = (lane: Lane, now: number) => now - lane.lastUsed < EVICT_MS;
const fetchMs = (r: () => number) => FETCH_COLD_MS[0] + r() * (FETCH_COLD_MS[1] - FETCH_COLD_MS[0]);

/** the owner of each authoritative key: where its writes serialize */
const owner = (key: number) => key;

type Scorer = (lanes: Lane[], job: Job, now: number) => Lane;

/** the baseline: the lane with the least recent CPU, lowest id first */
const cpuOnly: Scorer = (lanes) => lanes.reduce((a, b) => (b.cpuLoad < a.cpuLoad ? b : a));

/**
 * expected completion: queue delay (the isolate's thread), restore cost (warm or cold), locality
 * (the job's trace against what the lane holds), and conflict (an authoritative write off its
 * owner is forwarded there and waits behind it)
 */
const byLatency: Scorer = (lanes, job, now) => {
	let best = lanes[0]!;
	let bestMs = Infinity;
	for (const lane of lanes) {
		let ms = readyAt(lanes, lane, now) - now + (warm(lane, now) ? WARM_MS : COLD_MS);
		ms += job.reads.filter((x) => !lane.resident.has(x.chunk)).length * FETCH_COLD_MS[1];
		if (job.effect === 'authoritative' && lane.id !== owner(job.key!)) ms += 10_000;
		if (ms < bestMs) [best, bestMs] = [lane, ms];
	}
	return best;
};

function simulate(jobs: Job[], score: Scorer, prefetch: boolean, seed: number) {
	const lanes = fresh();
	const r = rng(seed ^ 0x5bd1e995);
	const latency: number[] = [];
	const stalls: number[] = [];
	let cold = 0;
	let conflicts = 0;
	let lastJob = 0;
	for (const job of jobs) {
		const now = job.at;
		// the CPU a lane ran, decayed with a 5 s time constant: what a CPU-only scorer sees
		for (const l of lanes) l.cpuLoad *= Math.exp(-(now - lastJob) / 5000);
		lastJob = now;
		let lane = score(lanes, job, now);
		let extra = 0;
		if (job.effect === 'authoritative' && lane.id !== owner(job.key!)) {
			// a write off its owner: forwarded, and it runs there after the owner's queue
			conflicts++;
			extra += FORWARD_MS;
			lane = lanes[owner(job.key!)]!;
		}
		const start = readyAt(lanes, lane, now) + extra;
		const startMs = warm(lane, start) ? WARM_MS : COLD_MS;
		if (!warm(lane, start)) {
			cold++;
			lane.resident.clear();
		}
		const running = start + startMs;
		// cold reads: fetched when needed, or all at dispatch by the plan from the last trace
		const ready = new Map<string, number>();
		if (prefetch)
			for (const x of job.reads.slice(0, PREFETCH_MAX))
				if (!lane.resident.has(x.chunk) && !ready.has(x.chunk))
					ready.set(x.chunk, start + fetchMs(r));
		let clock = running;
		let used = 0;
		let stall = 0;
		for (const x of job.reads) {
			clock += x.atMs - used;
			used = x.atMs;
			const at = lane.resident.has(x.chunk)
				? clock + FETCH_WARM_MS
				: (ready.get(x.chunk) ?? clock + fetchMs(r));
			if (at > clock) {
				stall += at - clock;
				clock = at;
			}
			lane.resident.add(x.chunk);
		}
		clock += job.cpuMs - used;
		const done = clock + job.waitMs;
		// an external wait holds the job, not the thread
		lane.busyUntil = clock;
		lane.lastUsed = done;
		lane.cpuLoad += job.cpuMs;
		latency.push(done - now);
		stalls.push(stall);
	}
	const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.floor(p * (xs.length - 1))]!;
	const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
	return {
		p50Ms: Math.round(pct(latency, 0.5)),
		p99Ms: Math.round(pct(latency, 0.99)),
		meanMs: Math.round(mean(latency)),
		coldReadStallMeanMs: Math.round(mean(stalls)),
		coldReadStallP99Ms: Math.round(pct(stalls, 0.99)),
		coldStarts: cold,
		forwardedWrites: conflicts
	};
}

// the scorer's own checks: a warm lane over a cold one, the owner for a write, the lane with the data
{
	const lanes = fresh();
	const job: Job = { at: 0, kind: 't', cpuMs: 10, effect: 'pure', waitMs: 0, reads: [{ chunk: 'c', atMs: 0 }] };
	lanes[5]!.lastUsed = -1;
	if (byLatency(lanes, { ...job, reads: [] }, 0).id !== 5) throw new Error('scorer: warm lane not chosen');
	lanes[7]!.lastUsed = -1;
	lanes[7]!.resident.add('c');
	if (byLatency(lanes, job, 0).id !== 7) throw new Error('scorer: the lane with the data not chosen');
	if (byLatency(lanes, { ...job, effect: 'authoritative', key: 2 }, 0).id !== 2)
		throw new Error('scorer: a write not sent to its owner');
}

const seed = Number(process.argv[2] ?? 1);
const jobs = workload(seed);
for (const [arm, score, prefetch] of [
	['cpu-only', cpuOnly, false],
	['latency+effects', byLatency, false],
	['latency+effects+prefetch', byLatency, true]
] as const)
	console.log(JSON.stringify({ arm, seed, jobs: jobs.length, ...simulate(jobs, score, prefetch, seed) }));
