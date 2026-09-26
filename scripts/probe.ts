import { appendFileSync, mkdirSync } from 'node:fs';

/** shared by the gate drivers: GATE_URL picks the deployment, rows land in ./results */
export const base = process.env.GATE_URL ?? 'http://localhost:8799';
const wsBase = base.replace(/^http/, 'ws');
const stamp = new Date().toISOString().slice(0, 10);
const logDir = '/tmp/gmux-gates';
mkdirSync(logDir, { recursive: true });
mkdirSync('results', { recursive: true });

export function record(gate: string, row: object) {
	const line = JSON.stringify({ at: new Date().toISOString(), base, ...row });
	appendFileSync(
		`results/${base.includes('localhost') ? 'local-' : ''}${stamp}-${gate}.jsonl`,
		`${line}\n`
	);
	appendFileSync(`${logDir}/progress.log`, `${new Date().toISOString()} ${gate} ${line}\n`);
	console.log(gate, line);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Socket {
	private queue: any[] = [];
	private waiters: ((m: any) => void)[] = [];
	closed: { code: number; reason: string } | null = null;
	private constructor(private readonly ws: WebSocket) {
		ws.addEventListener('message', (e) => {
			const msg = JSON.parse(String(e.data));
			const waiter = this.waiters.shift();
			if (waiter) waiter(msg);
			else this.queue.push(msg);
		});
		ws.addEventListener('close', (e) => {
			this.closed = { code: e.code, reason: e.reason };
			for (const w of this.waiters.splice(0)) w({ op: 'closed', ...this.closed });
		});
	}

	static open(query: string): Promise<Socket> {
		const ws = new WebSocket(`${wsBase}/ws?${query}`);
		return new Promise((resolve, reject) => {
			ws.addEventListener('open', () => resolve(new Socket(ws)));
			ws.addEventListener('error', (e) => reject(e));
		});
	}

	send(body: object) {
		this.ws.send(JSON.stringify(body));
	}

	next(timeoutMs = 120_000): Promise<any> {
		const queued = this.queue.shift();
		if (queued) return Promise.resolve(queued);
		if (this.closed) return Promise.resolve({ op: 'closed', ...this.closed });
		return new Promise((resolve) => {
			const timer = setTimeout(() => resolve({ op: 'timeout' }), timeoutMs);
			this.waiters.push((m) => {
				clearTimeout(timer);
				resolve(m);
			});
		});
	}

	/** reads until a message whose op is not progress, keeping the last progress seen */
	async until(ops: string[], timeoutMs = 120_000) {
		let last: any = null;
		for (;;) {
			const m = await this.next(timeoutMs);
			if (m.op === 'progress') {
				last = m;
				continue;
			}
			if (ops.includes(m.op) || m.op === 'closed' || m.op === 'timeout' || m.op === 'error') {
				return { msg: m, lastProgress: last };
			}
		}
	}

	close() {
		this.ws.close();
	}
}

export const get = async (path: string) => (await fetch(`${base}${path}`)).json() as Promise<any>;
