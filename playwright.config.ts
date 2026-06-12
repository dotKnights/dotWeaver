import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: './tests/e2e',
	testMatch: '**/*.e2e.{ts,js}',
	globalTeardown: './tests/e2e/global-teardown.ts',
	timeout: 30000,
	use: {
		// Must match BETTER_AUTH_URL so better-auth accepts the request Origin (CSRF check).
		baseURL: 'http://localhost:5173'
	},
	webServer: {
		command: 'bun run build && bun run preview -- --port 5173',
		port: 5173,
		timeout: 120000,
		reuseExistingServer: !process.env.CI
	}
});
