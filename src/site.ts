import type { Env } from './site-do';

export { MachineDO } from './site-do';

const MACHINE = 'default';

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/_gmux/term' || url.pathname === '/_gmux/term/') {
			return env.ASSETS.fetch(new URL('/_gmux/term/index.html', url));
		}
		return env.MACHINE.get(env.MACHINE.idFromName(MACHINE)).fetch(request);
	}
} satisfies ExportedHandler<Env>;
