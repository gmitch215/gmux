import { DurableObject } from 'cloudflare:workers';
import { parkTasks } from '../../jspi-parks/src/machine';
import busyboxModule from '../../boot/vendor/busybox.wasm';
import vmlinuxModule from '../../boot/vendor/vmlinux.min.wasm';

interface Env {
	PROBE: DurableObjectNamespace<Probe>;
	ASSETS?: Fetcher;
}

function touch(bytes: Uint8Array) {
	for (let i = 0; i < bytes.length; i += 4096) bytes[i] = 1;
}

export class Probe extends DurableObject<Env> {
	private readonly instance = crypto.randomUUID();
	private held: WebAssembly.Memory[] = [];
	private kept: WebAssembly.Instance[] = [];
	private shared: WebAssembly.Memory | null = null;
	private parked: { parked: number; drain: () => Promise<void> } | null = null;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const q = (n: string, f: number) => Number(url.searchParams.get(n) ?? f);
		const op = url.pathname.slice(1);
		const who = { op, instance: this.instance };
		try {
			switch (op) {
				case 'mem': {
					const stacks = q('stacks', 0);
					const parked = stacks ? await parkTasks(stacks, q('depth', 1024)) : null;
					const mb = q('mb', 64);
					const memory = new WebAssembly.Memory({ initial: mb * 16 });
					touch(new Uint8Array(memory.buffer));
					await parked?.drain();
					return Response.json({
						...who,
						mb,
						stacks,
						parked: parked?.parked ?? 0,
						bytes: memory.buffer.byteLength
					});
				}
				case 'hold': {
					const mb = q('mb', 32);
					try {
						const memory = new WebAssembly.Memory({ initial: mb * 16 });
						touch(new Uint8Array(memory.buffer));
						this.held.push(memory);
					} catch (error) {
						return Response.json({
							...who,
							heldMb: this.held.reduce((a, m) => a + m.buffer.byteLength, 0) >> 20,
							error: String(error)
						});
					}
					return Response.json({
						...who,
						heldMb: this.held.reduce((a, m) => a + m.buffer.byteLength, 0) >> 20
					});
				}
				case 'grow': {
					this.shared ??= new WebAssembly.Memory({
						initial: 16,
						maximum: 65536,
						shared: true
					});
					const before = this.shared.buffer.byteLength;
					try {
						this.shared.grow(q('mb', 8) * 16);
					} catch (error) {
						return Response.json({ ...who, mb: before >> 20, error: String(error) });
					}
					touch(new Uint8Array(this.shared.buffer, before));
					return Response.json({ ...who, heldMb: this.shared.buffer.byteLength >> 20 });
				}
				case 'park': {
					this.parked ??= await parkTasks(q('tasks', 1000), q('depth', 1024));
					return Response.json({ ...who, parked: this.parked.parked });
				}
				case 'drop':
					await this.parked?.drain();
					this.parked = null;
					this.shared = null;
					this.held = [];
					return Response.json(who);
				case 'knee': {
					const t0 = Date.now();
					const parked = await parkTasks(q('tasks', 32000), q('depth', 16));
					await parked.drain();
					return Response.json({
						...who,
						tasks: q('tasks', 32000),
						parked: parked.parked,
						wallMs: Date.now() - t0
					});
				}
				case 'instances': {
					const n = q('n', 20);
					const memory = new WebAssembly.Memory({
						initial: 15,
						maximum: 2048,
						shared: true
					});
					const kind = url.searchParams.get('kind') ?? 'vmlinux';
					const imports: Record<string, unknown> = { memory };
					const module = kind === 'vmlinux' ? vmlinuxModule : busyboxModule;
					for (const i of WebAssembly.Module.imports(module)) {
						if (i.kind === 'function') imports[i.name] = () => 0;
						if (i.kind === 'global')
							imports[i.name] = new WebAssembly.Global(
								{ value: 'i32', mutable: i.name === '__stack_pointer' },
								i.name === '__table_base' ? 0 : 0x100000
							);
						if (i.kind === 'table')
							imports[i.name] = new WebAssembly.Table({
								initial: 4096,
								element: 'anyfunc'
							});
					}
					if (kind === 'busybox') memory.grow(128);
					const keep: WebAssembly.Instance[] = [];
					for (let i = 0; i < n; i++)
						keep.push(
							new WebAssembly.Instance(module, {
								env: imports as WebAssembly.ModuleImports
							})
						);
					if (url.searchParams.get('keep') === '1') this.kept.push(...keep);
					return Response.json({
						...who,
						kind,
						n,
						kept: keep.length,
						total: this.kept.length
					});
				}

				case 'who':
					return Response.json(who);
			}
			return new Response('unknown', { status: 404 });
		} catch (error) {
			return Response.json({ ...who, error: String(error) }, { status: 500 });
		}
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		return env.PROBE.get(env.PROBE.idFromName(url.searchParams.get('do') ?? 'default')).fetch(
			request
		);
	}
} satisfies ExportedHandler<Env>;
