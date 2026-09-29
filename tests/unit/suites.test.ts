import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { same } from '../suites/account.ts';
import { command, pairs, results, settle } from '../suites/coreutils-gmux.ts';

describe('tests/suites, the upstream suite runner', () => {
	it("reads the driver's lines from a machine's console, CRs and log lines and all", () => {
		const console =
			'~ # sh /coreutils-test.sh tests/a.sh tests/b/c.sh\r\nPASS tests/a.sh\r\n| a log line\r\n' +
			'SKIP tests/b/c.sh\r\nFAIL tests/not-a-line\r\nFAIL: tests/x.sh\r\nERROR tests/d.sh\r\nEND-42\r\n';
		expect([...results(console)]).toEqual([
			['tests/a.sh', 'PASS'],
			['tests/b/c.sh', 'SKIP'],
			['tests/not-a-line', 'FAIL'],
			['tests/d.sh', 'ERROR']
		]);
	});

	it('types one line per batch, ending with a marker the command itself does not echo', () => {
		const c = command(['tests/a.sh', 'tests/b.sh']);
		expect(c).toBe('sh /coreutils-test.sh tests/a.sh tests/b.sh 2>&1; echo END-$((6*7))');
		expect(c).not.toContain('END-42');
		expect(command(['tests/a.sh'], true)).toMatch(/^CU_LOG=1 sh /);
	});

	it('ends a hung test as TIMEOUT and runs the rest of its batch again, or reports LOST', () => {
		const got = new Map([
			['a', 'PASS'],
			['b', 'FAIL']
		]);
		expect(settle(['a', 'b'], got, true)).toEqual({ lines: ['PASS a', 'FAIL b'], rest: [] });
		expect(settle(['a', 'b', 'c', 'd'], got, true)).toEqual({
			lines: ['PASS a', 'FAIL b', 'TIMEOUT c'],
			rest: ['d']
		});
		expect(settle(['a', 'b', 'c', 'd'], got, false)).toEqual({
			lines: ['PASS a', 'FAIL b', 'LOST c', 'LOST d'],
			rest: []
		});
		expect(settle(['c'], new Map(), true)).toEqual({ lines: ['TIMEOUT c'], rest: [] });
	});

	it('puts the tree under /cu with its bash and the driver', () => {
		const cu = mkdtempSync(join(tmpdir(), 'gmux-suite-'));
		mkdirSync(join(cu, 'tests/misc'), { recursive: true });
		writeFileSync(join(cu, 'tests/misc/echo.sh'), '');
		writeFileSync(join(cu, 'links.txt'), '');
		expect(pairs(cu, '/b/bash', '/d/test.sh').sort()).toEqual(
			[
				`/cu/links.txt=${cu}/links.txt`,
				`/cu/tests/misc/echo.sh=${cu}/tests/misc/echo.sh`,
				'/bin/bash=/b/bash',
				'/coreutils-test.sh=/d/test.sh'
			].sort()
		);
	});

	it('compares an account with what it held before, whatever the order', () => {
		const before = { workers: ['a', 'b'], namespaces: ['n'], kv: ['x', 'y'] };
		expect(same(before, { workers: ['b', 'a'], namespaces: ['n'], kv: ['y', 'x'] })).toBe(true);
		expect(same(before, { ...before, workers: ['a', 'b', 'gmux-suite'] })).toBe(false);
		expect(same(before, { ...before, namespaces: [] })).toBe(false);
		expect(same(before, { ...before, kv: ['x'] })).toBe(false);
	});
});
