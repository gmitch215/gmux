import { createServer } from 'node:http';
import { type BrowserType, chromium, firefox, webkit } from '@playwright/test';
import { connect } from './guest.ts';

/**
 * Asks each browser whether a page the machine serves can register a service worker, by the Link
 * header (`rel=serviceworker`) or by calling register() itself, then reads the registrations from
 * a second page of the same origin (the terminal page). The guest answers /cgi-bin/page.cgi and
 * /sw.js; a local server with no Content-Security-Policy is the control that shows a registration
 * is detected when the browser allows one, and its two half-sandboxed arms say which reply the
 * sandbox on the guest page or the one on the worker script stops.
 * WORKER_URL=<base url> node --experimental-strip-types experiments/serving/scripts/sw.ts
 */
const base = (process.env.WORKER_URL ?? '').replace(/\/$/, '');
if (!base) {
	console.error('usage: WORKER_URL=<base url> node --experimental-strip-types sw.ts');
	process.exit(2);
}
const SANDBOX = 'sandbox allow-scripts allow-forms';
const LINK = '</sw.js>; rel="serviceworker"';
const PAGE =
	'<!doctype html><title>g</title><pre id="r">pending</pre><script>(async()=>{' +
	'const o={secure:window.isSecureContext,origin:String(location.origin),hasWorker:"serviceWorker" in navigator};' +
	'if(location.search.includes("register")){try{const g=await navigator.serviceWorker.register("/sw.js"+(location.search.includes("swcsp")?"?sw=sandbox":""));o.register="ok";o.scope=g.scope}catch(e){o.register=String(e)}}' +
	'document.getElementById("r").textContent=JSON.stringify(o)})()</script>';
const WORKER = 'self.addEventListener("fetch",()=>{})';

// #region guest
const guest = await connect(base);
const sh = guest.sh;
await sh('mkdir -p /www/cgi-bin');
await sh(`printf '%s\\n' '${PAGE}' > /www/page.html; printf '%s' '${WORKER}' > /www/sw.js`);
await sh(
	`printf '%s\\n' 'Link: ${LINK}' > /www/h-plain; printf '%s\\n' 'Link: ${LINK}; scope="/"' > /www/h-scope`
);
await sh(
	`printf '#!/bin/sh\\necho "Content-Type: text/html"\\ncase "$QUERY_STRING" in *scope*) cat /www/h-scope;; *) cat /www/h-plain;; esac\\necho "Service-Worker-Allowed: /"\\necho\\ncat /www/page.html\\n' > /www/cgi-bin/page.cgi; chmod +x /www/cgi-bin/page.cgi`
);
await sh(`printf '.js:text/javascript\\n' > /etc/httpd.conf; httpd -p 80 -h /www`);
await sh('sleep 1');
// #endregion

// #region control
const local = createServer((request, response) => {
	const url = new URL(request.url!, 'http://local');
	const csp = (on: boolean) => (on ? { 'content-security-policy': SANDBOX } : {});
	if (url.pathname === '/sw.js')
		response.writeHead(200, {
			'content-type': 'text/javascript',
			...csp(url.searchParams.get('sw') === 'sandbox')
		});
	else
		response.writeHead(200, {
			'content-type': 'text/html',
			link: url.search.includes('scope') ? `${LINK}; scope="/"` : LINK,
			'service-worker-allowed': '/',
			...csp(url.pathname === '/page-sandbox')
		});
	response.end(url.pathname === '/sw.js' ? WORKER : PAGE);
});
await new Promise<void>((r) => local.listen(0, '127.0.0.1', r));
const localBase = `http://127.0.0.1:${(local.address() as { port: number }).port}`;
// #endregion

async function probe(type: BrowserType, origin: string, page: string, other: string) {
	// a browser build other than the one this Playwright wants: WEBKIT_PATH=<executable>
	const browser = await type.launch({
		executablePath: process.env[`${type.name().toUpperCase()}_PATH`]
	});
	const context = await browser.newContext();
	try {
		const first = await context.newPage();
		const errors: string[] = [];
		first.on('pageerror', (error) => errors.push(String(error)));
		await first.goto(`${origin}${page}`);
		await first.waitForTimeout(3000);
		const report = await first.locator('#r').textContent();
		const second = await context.newPage();
		await second.goto(`${origin}${other}`);
		const registrations = await second.evaluate(async () => {
			if (!('serviceWorker' in navigator)) return 'no navigator.serviceWorker';
			const all = await navigator.serviceWorker.getRegistrations();
			return all.map((r) => ({
				scope: r.scope,
				script: (r.active ?? r.waiting ?? r.installing)?.scriptURL
			}));
		});
		return {
			browser: `${type.name()} ${browser.version()}`,
			page,
			report: report && report !== 'pending' ? JSON.parse(report) : report,
			registrations,
			workers: context.serviceWorkers().map((w) => w.url()),
			errors
		};
	} finally {
		await browser.close();
	}
}

const names = (process.env.BROWSERS ?? 'chromium,webkit,firefox').split(',');
const types = { chromium, webkit, firefox } as Record<string, BrowserType>;
for (const name of names) {
	const type = types[name]!;
	const arms: [string, string, string, string][] = [
		['guest link', base, '/cgi-bin/page.cgi', '/_gmux/term/'],
		['guest link scope', base, '/cgi-bin/page.cgi?scope', '/_gmux/term/'],
		['guest register', base, '/cgi-bin/page.cgi?register', '/_gmux/term/'],
		['control link', localBase, '/page', '/other'],
		['control link scope', localBase, '/page?scope', '/other'],
		['control register', localBase, '/page?register', '/other'],
		['control page sandbox, register', localBase, '/page-sandbox?register', '/other'],
		['control script sandbox, register', localBase, '/page?register&swcsp', '/other']
	];
	for (const [arm, origin, page, other] of arms)
		try {
			console.log(JSON.stringify({ arm, ...(await probe(type, origin, page, other)) }));
		} catch (error) {
			console.log(JSON.stringify({ arm, browser: name, error: String(error) }));
		}
}
guest.close();
local.close();
process.exit(0);
