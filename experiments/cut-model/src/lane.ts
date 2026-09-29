import { DurableObject } from 'cloudflare:workers';

interface Env {
	MACHINE: DurableObjectNamespace<Machine>;
	LANE: DurableObjectNamespace<Lane>;
}

export class Lane extends DurableObject<Env> {
	nop(a: number) {
		return a + 1;
	}

	bytes(n: number) {
		return new Uint8Array(n);
	}
}

/** calls a lane n times, awaiting each answer: what one MachineDO to LaneDO crossing costs */
export class Machine extends DurableObject<Env> {
	async cross(n: number, size: number, lane: string) {
		const stub = this.env.LANE.get(this.env.LANE.idFromName(lane));
		let s = 0;
		const t0 = performance.now();
		if (size) for (let i = 0; i < n; i++) s += (await stub.bytes(size)).length;
		else for (let i = 0; i < n; i++) s = await stub.nop(s);
		return { ms: performance.now() - t0, s };
	}

	/** the same n calls with no crossing: the loop and the await alone */
	async loop(n: number) {
		let s = 0;
		const t0 = performance.now();
		for (let i = 0; i < n; i++) s = await Promise.resolve(s + 1);
		return { ms: performance.now() - t0, s };
	}
}

export default {
	async fetch(request: Request, env: Env) {
		const url = new URL(request.url);
		const n = Number(url.searchParams.get('n') ?? 1000);
		const machine = env.MACHINE.get(env.MACHINE.idFromName('machine'));
		if (url.pathname === '/loop') return Response.json(await machine.loop(n));
		return Response.json(await machine.cross(n, Number(url.searchParams.get('size') ?? 0), url.searchParams.get('lane') ?? 'lane'));
	}
};
