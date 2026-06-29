import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
	plugins: [tailwindcss(), svelte()],
	resolve: {
		alias: [
			{
				find: '$lib/rfc/connectors.remote',
				replacement: fromRoot('./tests/mocks/rfc/connectors.remote.ts')
			},
			{ find: '$lib/rfc/mail.remote', replacement: fromRoot('./tests/mocks/rfc/mail.remote.ts') },
			{ find: '$lib/rfc/poke.remote', replacement: fromRoot('./tests/mocks/rfc/poke.remote.ts') },
			{
				find: '$lib/rfc/project-agent-config.remote',
				replacement: fromRoot('./tests/mocks/rfc/project-agent-config.remote.ts')
			},
			{
				find: '$lib/rfc/project-environment-services.remote',
				replacement: fromRoot('./tests/mocks/rfc/project-environment-services.remote.ts')
			},
			{
				find: '$lib/rfc/project-environments.remote',
				replacement: fromRoot('./tests/mocks/rfc/project-environments.remote.ts')
			},
			{
				find: '$lib/rfc/projects.remote',
				replacement: fromRoot('./tests/mocks/rfc/projects.remote.ts')
			},
			{ find: '$lib/rfc/runs.remote', replacement: fromRoot('./tests/mocks/rfc/runs.remote.ts') },
			{ find: '$lib/rfc/teams.remote', replacement: fromRoot('./tests/mocks/rfc/teams.remote.ts') },
			{ find: '$lib', replacement: fromRoot('./src/lib') },
			{ find: '$app/environment', replacement: fromRoot('./tests/mocks/app/environment.ts') },
			{ find: '$app/navigation', replacement: fromRoot('./tests/mocks/app/navigation.ts') },
			{ find: '$app/state', replacement: fromRoot('./tests/mocks/app/state.ts') }
		]
	},
	test: {
		name: 'client',
		expect: { requireAssertions: true },
		passWithNoTests: true,
		browser: {
			enabled: true,
			provider: playwright(),
			instances: [{ browser: 'chromium', headless: true }]
		},
		include: ['tests/unit/**/*.svelte.{test,spec}.{js,ts}'],
		exclude: ['src/lib/server/**', 'tests/unit/lib/server/**']
	}
});
