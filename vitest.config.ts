import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['tests/unit/**/*.test.ts'],
		globalSetup: ['tests/unit/setup-router.ts'],
		coverage: {
			provider: 'istanbul',
			include: ['src/**/*.ts'],
			exclude: ['src/**/*.d.ts'],
			reporter: ['text-summary', 'clover', 'lcov']
		}
	}
});
