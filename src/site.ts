import type { Env } from './site-do';

export { MachineDO } from './site-do';

const MACHINE = 'default';

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/_gmux/term' || url.pathname === '/_gmux/term/') {
			return env.ASSETS.fetch(new URL('/_gmux/term/index.html', url));
		}
		if (url.pathname.startsWith('/_gmux/'))
			return env.MACHINE.get(env.MACHINE.idFromName(MACHINE)).fetch(request);
		return new Response(
			'gmux: this machine serves no site yet; the terminal is at /_gmux/term',
			{ status: 503 }
		);
	}
} satisfies ExportedHandler<Env>;
