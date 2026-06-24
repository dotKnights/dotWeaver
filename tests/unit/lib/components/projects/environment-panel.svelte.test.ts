import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import EnvironmentPanel from '$lib/components/projects/EnvironmentPanel.svelte';

describe('EnvironmentPanel', () => {
	it('renders an unconfigured state with detect action', async () => {
		const screen = render(EnvironmentPanel, {
			projectId: 'p1',
			environment: null,
			onDetect: vi.fn(),
			onSave: vi.fn(),
			onPrepare: vi.fn()
		});

		await expect.element(screen.getByText('Environment')).toBeInTheDocument();
		await expect.element(screen.getByText('Not configured')).toBeInTheDocument();
		await expect.element(screen.getByRole('button', { name: /detect/i })).toBeInTheDocument();
	});

	it('renders a ready Node environment', async () => {
		const screen = render(EnvironmentPanel, {
			projectId: 'p1',
			environment: {
				id: 'env1',
				runtime: 'node',
				packageManager: 'bun',
				status: 'ready',
				lastPrepareStatus: 'succeeded',
				installCommand: 'bun install',
				testCommand: 'bun run test',
				buildCommand: '',
				devCommand: '',
				warnings: []
			},
			onDetect: vi.fn(),
			onSave: vi.fn(),
			onPrepare: vi.fn()
		});

		await expect.element(screen.getByText('node')).toBeInTheDocument();
		await expect.element(screen.getByText('bun')).toBeInTheDocument();
		await expect.element(screen.getByRole('button', { name: /prepare/i })).toBeInTheDocument();
	});
});
