import { join } from 'node:path';
import { defineConfig, mergeConfig } from 'vitest/config';
import base from '../../vitest.config.ts';

// the unit suite with the wat flag's recorder (scripts/lcov/wat.ts)
export default mergeConfig(
	base,
	defineConfig({
		root: join(import.meta.dirname, '../..'),
		test: { setupFiles: ['tests/lcov/wat-setup.ts'] }
	})
);
