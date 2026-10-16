import { describe, expect, it } from 'vitest';
import { shapesReport } from '../../experiments/serving/scripts/shapes-table.ts';

const sample = (
	server: string,
	cell: string,
	run: number,
	cpu: number,
	quiet = 'outside_busy 0.10',
	ok = 1
) =>
	JSON.stringify({
		server,
		cell,
		run,
		quiet,
		ok,
		out: {
			cpuMs: { mean: cpu },
			steps: { mean: 13 },
			perRequest: { nextCalls: 6, sendCalls: 1, endCalls: 3 },
			steady: { memFreeKb: 238000, tasks: 50, openStreams: 0 }
		}
	});

describe('shapes table', () => {
	it('sets each cell against its own server seq control and holds the keepalive saving to the threshold', () => {
		const out = shapesReport(
			[
				sample('lighttpd', 'seq', 1, 1.0),
				sample('lighttpd', 'seq', 2, 1.1),
				sample('lighttpd', 'seq', 3, 1.0),
				sample('lighttpd', 'keepalive', 1, 0.8),
				sample('lighttpd', 'keepalive', 2, 0.8),
				sample('lighttpd', 'keepalive', 3, 0.8),
				sample('lighttpd', 'conc4', 1, 1.0),
				sample('httpd', 'seq', 1, 2.0)
			].join('\n')
		).join('\n');
		expect(out).toContain('| lighttpd | seq | 3 | 1.000, 1.100, 1.000 | 1.000 | 10.0 | - |');
		expect(out).toContain(
			'| lighttpd | keepalive | 3 | 0.800, 0.800, 0.800 | 0.800 | 0.0 | -20.0 |'
		);
		expect(out).toContain('| lighttpd | conc4 | 1 | 1.000 | 1.000 | 0.0 | 0.0 |');
		expect(out).toContain('| httpd | seq | 1 | 2.000 | 2.000 | 0.0 | - |');
		expect(out).toContain('lighttpd: keepalive saves 20.0% of a request');
		expect(out).toContain('threshold 10%: met');
		expect(out).not.toMatch(/^httpd: keepalive/m);
	});

	it('lists a smoke sample and a failed one apart from the medians', () => {
		const out = shapesReport(
			[
				sample('httpd', 'seq', 1, 1.0),
				sample('httpd', 'seq', 2, 9.0, 'outside_busy 0.90'),
				sample('httpd', 'conc2', 1, 1.0),
				sample('httpd', 'conc2', 2, 50, 'outside_busy 0.10', 0)
			].join('\n')
		).join('\n');
		expect(out).toContain('| httpd | seq | 1 | 1.000, 9.000 | 1.000 | 0.0 | - |');
		expect(out).toMatch(/\| httpd \| seq \| 1 \|.*\| 1 \|$/m);
		expect(out).toContain('| httpd | conc2 | 1 | 1.000 |');
	});
});
