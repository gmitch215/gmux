/**
 * A shell in a running site's machine, through the terminal WebSocket the way scripts/smoke.ts and
 * the page do: claims the machine (or uses GMUX_TOKEN), keeps it ticking and runs lines for `sh`.
 */
export async function connect(base: string, timeoutMs = 180_000) {
	let owner = process.env.GMUX_TOKEN;
	if (!owner) {
		const claim = await get(base, '/_gmux/claim', { method: 'POST' });
		owner = ((await claim.json()) as { token?: string }).token;
		if (!owner) throw new Error(`claim: ${claim.status}`);
		console.error(`GMUX_TOKEN=${owner}`);
	}
	const open = (kind: string) =>
		new Promise<WebSocket>((resolve, reject) => {
			const ws = new WebSocket(
				`${base.replace(/^http/, 'ws')}/_gmux/term/ws?kind=${kind}&token=${encodeURIComponent(owner!)}`
			);
			ws.addEventListener('open', () => resolve(ws), { once: true });
			ws.addEventListener('error', () => reject(new Error(`${kind} socket failed`)), {
				once: true
			});
		});
	const control = await open('control');
	const warm = await open('warm');
	const ticker = setInterval(() => control.send(JSON.stringify({ t: 'tick' })), 1000);
	let output = '';
	control.addEventListener('message', (event) => {
		const msg = JSON.parse(String(event.data)) as { t: string; d: string };
		if (msg.t === 'out') output += msg.d;
	});
	const until = async (done: () => boolean, what: string) => {
		for (const started = Date.now(); !done(); ) {
			if (Date.now() - started > timeoutMs) throw new Error(`no ${what}:\n${output.slice(-1500)}`);
			await new Promise((r) => setTimeout(r, 100));
		}
	};
	control.send(JSON.stringify({ t: 'in', d: '\n' }));
	await until(() => output.includes('# '), 'prompt');
	return {
		owner,
		/** runs a line and returns what the terminal printed for it */
		async sh(command: string) {
			const from = output.length;
			control.send(JSON.stringify({ t: 'in', d: `${command}; echo rc=$?-end\n` }));
			await until(() => output.includes('-end', from + command.length), 'answer');
			return output.slice(from);
		},
		close() {
			clearInterval(ticker);
			control.close();
			warm.close();
		}
	};
}

/** a request that may meet the placement 503 of a new object: retried */
export async function get(
	base: string,
	path: string,
	init: RequestInit = {},
	retries = 4
): Promise<Response> {
	const response = await fetch(`${base}${path}`, init);
	if (response.status === 503 && retries > 0) {
		await response.arrayBuffer();
		await new Promise((r) => setTimeout(r, 1500));
		return get(base, path, init, retries - 1);
	}
	return response;
}
