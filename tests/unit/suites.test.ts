import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { command, pairs, results } from '../suites/coreutils-gmux.ts';
import { KV, onBaseline } from '../suites/free.ts';

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

	it('holds the Free account to its baseline: no Worker, no namespace, only its two KV', () => {
		expect(onBaseline({ workers: [], namespaces: [], kv: [...KV].reverse() })).toBe(true);
		expect(onBaseline({ workers: ['gmux-suite'], namespaces: [], kv: KV })).toBe(false);
		expect(onBaseline({ workers: [], namespaces: ['gmux-suite_SuiteMachine'], kv: KV })).toBe(
			false
		);
		expect(onBaseline({ workers: [], namespaces: [], kv: [KV[0]!] })).toBe(false);
	});
});
