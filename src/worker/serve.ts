import { QUANTUM_MS } from './keeper';
import { BodyTooLarge, GatewayTimeout, requestBytes, responseFrom } from './machine/http';
import type { IngressStream } from './machine/ingress';
import { MAX_OPEN_STREAMS, MAX_REQUEST_BYTES, PUBLIC_PORT, SERVE_LIMIT_MS } from './site-machine';

/** what serving needs of a running machine */
export interface ServeMachine {
	listening(port: number): boolean;
	ingress(port: number): IngressStream;
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
}

const SITE_LIMITS: ServeLimits = {
	port: PUBLIC_PORT,
	timeoutMs: SERVE_LIMIT_MS,
	maxStreams: MAX_OPEN_STREAMS,
	maxRequestBytes: MAX_REQUEST_BYTES
};

/** requests outside /_gmux/, served by whatever listens on the machine's public port */
export class Server {
	private serving = 0;
	private readonly limits: ServeLimits;

	constructor(
		private readonly host: ServeHost,
		limits: Partial<ServeLimits> = {}
	) {
		this.limits = { ...SITE_LIMITS, ...limits };
	}

	/** streams a request holds open in the machine */
	get open(): number {
		return this.serving;
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
		const { port, maxStreams, maxRequestBytes } = this.limits;
		// a declared body over the bound is refused before the machine is woken
		if (Number(request.headers.get('content-length')) > maxRequestBytes)
			return new Response('request body too large', { status: 413 });
		const machine = await this.host.open();
		if (!machine.listening(port))
			return new Response('nothing listens on port 80', {
				status: 503,
				headers: { 'retry-after': '1' }
			});
		// checked and raised with no await between, so concurrent requests cannot both take the last slot
		if (this.serving >= maxStreams)
			return new Response('too many open requests', {
				status: 503,
				headers: { 'retry-after': '1' }
			});
		const stream = machine.ingress(port);
		this.serving++;
		let over = false;
		let tooLarge = false;
		const finish = (clean: boolean) => {
			if (over) return;
			over = true;
			this.serving--;
			if (clean) stream.end();
			else stream.abort();
		};
		const sent = (async () => {
			for await (const chunk of requestBytes(request, maxRequestBytes))
				await stream.write(chunk);
		})();
		sent.catch((error) => {
			tooLarge ||= error instanceof BodyTooLarge;
			finish(false);
		});
		try {
			const response = await this.drive(
				responseFrom(stream.readable, request.method, finish)
			);
			const reader = response.body?.getReader();
			if (!reader) return response;
			// every read of the body drives the machine, so a slow reader slows the guest
			const body = new ReadableStream<Uint8Array>({
				pull: async (controller) => {
					try {
						const { done, value } = await this.drive(reader.read());
						if (done) controller.close();
						else controller.enqueue(value);
					} catch (error) {
						finish(false);
						controller.error(error);
					}
					await this.settle();
				},
				cancel: async (reason) => {
					finish(false);
					await reader.cancel(reason);
					await this.settle();
				}
			});
			// a body of known length goes out under its Content-Length, as the machine sent it
			const length = Number(response.headers.get('content-length'));
			if (!Number.isSafeInteger(length) || response.headers.get('content-length') === null)
				return new Response(body, response);
			const { readable, writable } = this.host.fixedLength(length);
			body.pipeTo(writable).catch(() => finish(false));
			return new Response(readable, response);
		} catch (error) {
			finish(false);
			if (tooLarge) return new Response('request body too large', { status: 413 });
			return new Response(
				error instanceof GatewayTimeout
					? 'gateway timeout'
					: `bad gateway: ${(error as Error).message}`,
				{ status: error instanceof GatewayTimeout ? 504 : 502 }
			);
		} finally {
			if (over) await this.settle();
		}
	}

	/** the last stream is done: the keeper checkpoints if due and points the alarm */
	async settle() {
		if (this.serving === 0 && !this.host.pumping()) await this.host.rest();
	}
}
