import { DatabaseSync } from 'node:sqlite';
import type { Sql } from '../../../src/worker/durable.ts';

/** `ctx.storage.sql` over node:sqlite, counting rows written as SQLite counts changes */
export function sqlite(path = ':memory:'): Sql & { written: number } {
	const db = new DatabaseSync(path);
	const sql = {
		written: 0,
		exec(query: string, ...bindings: (string | number | ArrayBuffer | Uint8Array | null)[]) {
			const stmt = db.prepare(query);
			const args = bindings.map((b) => (b instanceof ArrayBuffer ? new Uint8Array(b) : b));
			if (/^\s*select/i.test(query)) {
				const rows = stmt.all(...args) as Record<string, unknown>[];
				return { toArray: () => rows, rowsWritten: 0 };
			}
			const rowsWritten = Number(stmt.run(...args).changes);
			sql.written += rowsWritten;
			return { toArray: () => [], rowsWritten };
		}
	};
	return sql;
}
