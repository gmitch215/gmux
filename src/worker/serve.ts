import { QUANTUM_MS } from './keeper.ts';
import { BodyTooLarge, GatewayTimeout, requestBytes, responseFrom } from './machine/http.ts';
import type { IngressStream } from './machine/ingress.ts';
import {
	IDLE_STREAM_MS,
	MAX_OPEN_STREAMS,
	MAX_REQUEST_BYTES,
	PUBLIC_PORT,
	SERVE_LIMIT_MS,
	STALLED_STREAM_MS
} from './site-machine.ts';

/** what serving needs of a running machine */
export interface ServeMachine {
	listening(port: number): boolean;
	ingress(port: number, borrows?: boolean): IngressStream;
	netPoll(): void;
	readonly netActivity: number;
}

/** what serving needs of the object that owns the machine */
export interface ServeHost {
	/** the machine, restored or booted first */
	open(): Promise<ServeMachine>;
	pumping(): boolean;
	/** runs the machine for up to `budgetMs`, or until `wake` says so */
	pump(budgetMs: number, wake: () => boolean): Promise<void>;
	/** the last stream is done: the keeper checkpoints if due and points the alarm */
	rest(): Promise<void>;
	wait(ms: number): Promise<void>;
	/** a body of known length goes out under its Content-Length (only workerd has the class) */
	fixedLength(length: number): { readable: ReadableStream<Uint8Array>; writable: WritableStream };
}

export interface ServeLimits {
	port: number;
	/** how long a request may wait for the machine to speak, ms */
	timeoutMs: number;
	maxStreams: number;
	maxRequestBytes: number;
	/** how long a finished stream waits for another request, ms; 0 closes each stream after its response */
	idleMs: number;
	/** how long an open stream may go without its client reading, ms; past it the stream is closed */
	stalledMs: number;
	/** lets the kernel lend its buffers to the response body instead of copying them (kernel patch 0041) */
	borrow: boolean;
}

const SITE_LIMITS: ServeLimits = {
	port: PUBLIC_PORT,
	timeoutMs: SERVE_LIMIT_MS,
	maxStreams: MAX_OPEN_STREAMS,
	maxRequestBytes: MAX_REQUEST_BYTES,
	idleMs: IDLE_STREAM_MS,
	stalledMs: STALLED_STREAM_MS,
	borrow: true
};

/** requests outside /_gmux/, served by whatever listens on the machine's public port */
export class Server {
	private serving = 0;
	/** finished streams the guest left open, oldest first */
	private readonly parked: { stream: IngressStream; at: number }[] = [];
	private sweeping = false;
	private readonly host: ServeHost;
	private readonly limits: ServeLimits;

	constructor(host: ServeHost, limits: Partial<ServeLimits> = {}) {
		this.host = host;
		this.limits = { ...SITE_LIMITS, ...limits };
	}

	/** streams a request holds open in the machine */
	get open(): number {
		return this.serving;
	}

	/** finished streams kept open for the next request; they count against the stream cap too */
	get idle(): number {
		return this.parked.length;
	}

	/**
	 * runs the machine until `work` settles, a turn at a time: a turn ends when a stream has something
	 * to read or `work` has settled, so the reader that waits can take it. A pump another request runs
	 * is waited out; a stream whose reader has room is woken here when its own pull has not
	 */
	async drive<T>(work: Promise<T>): Promise<T> {
		let settled = false;
		work.then(
			() => (settled = true),
			() => (settled = true)
		);
		let quiet = Date.now();
		while (!settled) {
			const machine = await this.host.open();
			const seen = machine.netActivity;
			if (this.host.pumping()) {
				machine.netPoll();
				await this.host.wait(2);
			} else
				await this.host.pump(QUANTUM_MS, () => {
					machine.netPoll();
					// a read that resolved on queued bytes has nothing new to wait for
					return settled || machine.netActivity !== seen;
				});
			if (machine.netActivity !== seen) quiet = Date.now();
			else if (!settled && Date.now() - quiet > this.limits.timeoutMs)
				throw new GatewayTimeout('the machine did not answer in time');
		}
		return work;
	}

	/** a request goes to whatever listens on the public port, as an ordinary connection */
	async serve(request: Request): Promise<Response> {
		const { port, maxStreams, maxRequestBytes, idleMs, borrow } = this.limits;
		// a declared body over the bound is refused before the machine is woken
		if (Number(request.headers.get('content-length')) > maxRequestBytes)
			return new Response('request body too large', { status: 413 });
		const machine = await this.host.open();
		if (!machine.listening(port))
			return new Response('nothing listens on port 80', {
				status: 503,
				headers: { 'retry-after': '1' }
			});
		// a kept stream the guest closed meanwhile is retried on a new one, so only GET and HEAD without
		// a body ride one (a server may also answer before it has read a body)
		const keepAlive =
			idleMs > 0 &&
			request.body === null &&
			(request.method === 'GET' || request.method === 'HEAD');
		const kept = keepAlive ? this.take() : undefined;
		if (kept) {
			const response = await this.exchange(request, kept, true, true);
			if (response) return response;
		}
		// checked and raised with no await between, so concurrent requests cannot both take the last slot
		if (this.serving >= maxStreams)
			return new Response('too many open requests', {
				status: 503,
				headers: { 'retry-after': '1' }
			});
		if (this.serving + this.parked.length >= maxStreams) this.parked.shift()!.stream.end();
		return (await this.exchange(request, machine.ingress(port, borrow), keepAlive, false))!;
	}

	/** the newest idle stream the guest has not closed and the pool has not outwaited */
	private take(): IngressStream | undefined {
		for (let next = this.parked.pop(); next; next = this.parked.pop()) {
			if (!next.stream.closed && Date.now() - next.at < this.limits.idleMs)
				return next.stream;
			next.stream.end();
		}
	}

	/** keeps a finished stream for the next request, and ends it once it has waited too long */
	private park(stream: IngressStream) {
		this.parked.push({ stream, at: Date.now() });
		void this.sweep();
	}

	/** ends idle streams as they time out, so a checkpoint (refused while a stream is open) is never held off for long */
	private async sweep() {
		if (this.sweeping) return;
		this.sweeping = true;
		try {
			for (let first = this.parked[0]; first; first = this.parked[0]) {
				const left = first.at + this.limits.idleMs - Date.now();
				if (left > 0) await this.host.wait(left);
				else this.parked.shift()!.stream.end();
			}
		} finally {
			this.sweeping = false;
		}
	}

	/**
	 * one request on `stream`, which is a new stream or an idle one (`reused`). A reused stream the
	 * guest closed meanwhile gives undefined when it failed before any reply, so the request can go
	 * to a new one
	 */
	private async exchange(
		request: Request,
		stream: IngressStream,
		keepAlive: boolean,
		reused: boolean
	): Promise<Response | undefined> {
		this.serving++;
		const borrow = this.limits.borrow;
		let over = false;
		let tooLarge = false;
		let wrote = false;
		let headed = false;
		let retry = false;
		let stalled: ReturnType<typeof setTimeout> | undefined;
		const finish = (clean: boolean, reusable = false) => {
			if (over) return;
			over = true;
			clearTimeout(stalled);
			this.serving--;
			// a reply that ended before the whole request went out leaves the stream mid-request
			if (clean && reusable && keepAlive && wrote && !stream.closed) this.park(stream);
			else if (clean) stream.end();
			else stream.abort();
		};
		const sent = (async () => {
			for await (const chunk of requestBytes(request, this.limits.maxRequestBytes, keepAlive))
				await stream.write(chunk);
			wrote = true;
		})();
		sent.catch((error) => {
			tooLarge ||= error instanceof BodyTooLarge;
			finish(false);
		});
		// a stream that lends its buffers is finished with once the last part of the body has gone out
		let ending: [boolean, boolean | undefined] | undefined;
		const ended = (clean: boolean, reusable?: boolean) => {
			if (borrow && clean) ending = [clean, reusable];
			else finish(clean, reusable);
		};
		try {
			const response = await this.drive(
				responseFrom(stream.readable, request.method, ended, () => stream.recycle())
			);
			headed = true;
			const reader = response.body?.getReader();
			if (!reader) {
				stream.releaseAll();
				if (ending) finish(...ending);
				return response;
			}
			// every read of the body drives the machine, so a slow reader slows the guest; it reads ahead
			// of nothing, so a part is used up by the time the next is asked for
			let bodyController!: ReadableStreamDefaultController<Uint8Array>;
			// a client that stops reading holds a slot and its guest connection until it is cut off here
			const arm = () => {
				clearTimeout(stalled);
				stalled = setTimeout(() => {
					if (over) return;
					finish(false);
					stream.releaseAll();
					bodyController.error(new Error('the client stopped reading'));
					void reader.cancel().catch(() => {});
					void this.settle();
				}, this.limits.stalledMs);
			};
			const body = new ReadableStream<Uint8Array>(
				{
					start: (controller) => void (bodyController = controller),
					pull: async (controller) => {
						clearTimeout(stalled);
						try {
							const { done, value } = await this.drive(reader.read());
							if (done) {
								stream.releaseAll();
								if (ending) finish(...ending);
								controller.close();
							} else controller.enqueue(value);
						} catch (error) {
							stream.releaseAll();
							finish(false);
							controller.error(error);
						}
						if (!over) arm();
						await this.settle();
					},
					cancel: async (reason) => {
						finish(false);
						await reader.cancel(reason);
						stream.releaseAll();
						await this.settle();
					}
				},
				{ highWaterMark: 0 }
			);
			arm();
			// a body of known length goes out under its Content-Length, as the machine sent it
			const length = Number(response.headers.get('content-length'));
			if (!Number.isSafeInteger(length) || response.headers.get('content-length') === null)
				return new Response(body, response);
			const { readable, writable } = this.host.fixedLength(length);
			body.pipeTo(writable).catch(() => finish(false));
			return new Response(readable, response);
		} catch (error) {
			finish(false);
			stream.releaseAll();
			if (tooLarge) return new Response('request body too large', { status: 413 });
			if (reused && !headed && !(error instanceof GatewayTimeout)) {
				retry = true;
				return undefined;
			}
			return new Response(
				error instanceof GatewayTimeout
					? 'gateway timeout'
					: `bad gateway: ${(error as Error).message}`,
				{ status: error instanceof GatewayTimeout ? 504 : 502 }
			);
		} finally {
			if (over && !retry) await this.settle();
		}
	}

	/** the last stream is done: the keeper checkpoints if due and points the alarm */
	async settle() {
		if (this.serving === 0 && !this.host.pumping()) await this.host.rest();
	}
}
