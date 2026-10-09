import { describe, expect, it } from 'vitest';
import { clean, type GapReading } from '../../scripts/restore-gap.ts';

const reading = (over: Partial<GapReading> = {}): GapReading => ({
	idle: '',
	command: 'echo gate-ok\r\ngate-ok\r\n~ # ',
	crashed: false,
	machineMs: 5000,
	...over
});

describe('restore gap check', () => {
	it('accepts a silent idle stretch and the command echoed back with a prompt', () => {
		expect(clean(reading())).toBe(true);
	});

	it('rejects any output while idle, such as a stall report', () => {
		expect(
			clean(reading({ idle: 'rcu: INFO: rcu_sched self-detected stall on CPU\r\n' }))
		).toBe(false);
		expect(clean(reading({ idle: '~ # ' }))).toBe(false);
	});

	it('rejects a command that printed extra lines, answered wrongly or never reached a prompt', () => {
		expect(clean(reading({ command: 'echo gate-ok\r\nrcu: INFO\r\ngate-ok\r\n~ # ' }))).toBe(
			false
		);
		expect(clean(reading({ command: 'echo gate-ok\r\nother\r\n~ # ' }))).toBe(false);
		expect(clean(reading({ command: 'echo gate-ok\r\n' }))).toBe(false);
	});

	it('rejects a crashed machine', () => {
		expect(clean(reading({ crashed: true }))).toBe(false);
	});
});
