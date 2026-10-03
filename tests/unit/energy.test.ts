import { describe, expect, it } from 'vitest';
import { loop } from '../../experiments/energy/src/drive.ts';
import { delta, net, span, type Snap } from '../../experiments/energy/src/rapl.ts';

const WRAP = 65_532_610_987;
const snap = (t: number, uj: number, busy: number, own: number): Snap => ({ t, uj, busy, own });

describe('energy rig counters', () => {
	it('reads a plain delta', () => {
		expect(delta(100, 350, WRAP)).toBe(250);
	});

	it('adds the range back across one wraparound', () => {
		expect(delta(WRAP - 10, 5, WRAP)).toBe(15);
	});

	it('reports joules, seconds and the cores that are not the rig', () => {
		// 2 s, 5 J, 400 busy jiffies of which 100 are the rig's own, 100 jiffies per s
		const w = span(snap(0, 0, 0, 0), snap(2000, 5_000_000, 400, 100), WRAP, 100);
		expect(w).toEqual({ s: 2, j: 5, other: 1.5 });
	});

	it('never reports negative other-tenant load', () => {
		expect(span(snap(0, 0, 0, 0), snap(1000, 1, 10, 50), WRAP, 100).other).toBe(0);
	});

	it('subtracts idle power over the window', () => {
		expect(net(100, 3, 16)).toBe(52);
	});

	it('wraps k runs of a command with its input substituted and its output sunk', () => {
		const line = loop('gzip -9 -c IN | wc -c', 3, { IN: '/tmp/in', OUT: '/tmp/out' }, false);
		expect(line).toContain('-lt 3');
		expect(line).toContain('gzip -9 -c /tmp/in | wc -c; } > /tmp/out 2>&1');
		expect(loop('echo IN', 1, { IN: 'x', OUT: 'y' }, true)).not.toContain('> y');
	});
});
