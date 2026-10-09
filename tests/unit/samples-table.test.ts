import { describe, expect, it } from 'vitest';
import { parseSamples, summarize } from '../../experiments/aot-oracle/scripts/samples-table.ts';

const line = (...f: (string | number)[]) => f.join('\t');
const text = [
	line('x86', 'gzip', 'fnc:2', 1, 'warm', 1, 900, 0.1, 1.0, 0),
	line('x86', 'gzip', 'fnc:2', 1, 1, 1, 880, 0.2, 1.0, 0),
	line('x86', 'gzip', 'fnc:2', 1, 2, 1, 990, 1.4, 1.1, 0),
	line('x86', 'gzip', 'fnc:2', 1, 2, 2, 870, 0.0, 1.1, 0),
	line('x86', 'gzip', 'fnc:2', 1, 3, 1, '-', '-', 1.1, 1),
	'not a sample'
].join('\n');

describe('samples table', () => {
	it('reads tab-separated sample lines and skips the rest', () => {
		const s = parseSamples(text);
		expect(s).toHaveLength(5);
		expect(s[2]).toMatchObject({
			arm: 'fnc:2',
			round: '2',
			attempt: 1,
			ms: 990,
			quiet: 1.4,
			rc: 0
		});
		expect(s[4]).toMatchObject({ quiet: null, rc: 1 });
	});

	it('counts kept, noisy and failed samples and takes the median of the kept times, warm run left out', () => {
		const [cell] = summarize(parseSamples(text));
		expect(cell).toMatchObject({
			arm: 'fnc:2',
			kept: 3,
			noisy: 1,
			failed: 1,
			quietMin: 0,
			quietMax: 1.4,
			ms: 880
		});
	});
});
