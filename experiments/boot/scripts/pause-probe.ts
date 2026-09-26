import { Worker } from 'node:worker_threads';

/** pauses the main thread after `ms` and prints its call stack, even inside a wasm loop */
export function pauseAfter(ms: number) {
	new Worker(
		`const inspector = require('node:inspector');
		const { writeSync } = require('node:fs');
		setTimeout(() => {
			const s = new inspector.Session();
			s.connectToMainThread();
			s.on('Debugger.paused', (e) => {
				const frames = e.params.callFrames.slice(0, 40).map((f) => f.functionName || '(anon)');
				writeSync(2, '[pause] stack:\\n  ' + frames.join('\\n  ') + '\\n');
				process.exit(0);
			});
			s.post('Debugger.enable', () => s.post('Debugger.pause'));
		}, ${ms});`,
		{ eval: true }
	);
}
