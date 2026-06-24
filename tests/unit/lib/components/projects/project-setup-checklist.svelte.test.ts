import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ProjectSetupChecklist from '$lib/components/projects/ProjectSetupChecklist.svelte';
import type { EnvironmentProfile } from '$lib/components/projects/environment-setup-state';

const project = {
	id: 'p1',
	owner: 'acme',
	name: 'repo',
	defaultBranch: 'main',
	private: false
};

function env(overrides: Partial<EnvironmentProfile> = {}): EnvironmentProfile {
	return {
		id: 'env1',
		status: 'detected',
		runtime: 'node',
		packageManager: 'bun',
		installCommand: 'bun install',
		currentFingerprint: 'fp1',
		lastPreparedFingerprint: null,
		lastPrepareStatus: 'never',
		lastPrepareError: null,
		warnings: [],
		...overrides
	};
}

describe('ProjectSetupChecklist', () => {
	it('shows detect action when no environment exists', async () => {
		const onDetect = vi.fn().mockResolvedValue({});
		const screen = render(ProjectSetupChecklist, {
			projectId: 'p1',
			project,
			environment: null,
			prepareEvents: [],
			onDetect,
			onSave: vi.fn(),
			onPrepare: vi.fn()
		});

		await expect.element(screen.getByText('Setup acme/repo')).toBeInTheDocument();
		await screen.getByRole('button', { name: /detect environment/i }).click();
		expect(onDetect).toHaveBeenCalledWith({ projectId: 'p1' });
	});

	it('shows prepare action when install command is required', async () => {
		const onPrepare = vi.fn().mockResolvedValue({});
		const screen = render(ProjectSetupChecklist, {
			projectId: 'p1',
			project,
			environment: env(),
			prepareEvents: [],
			onDetect: vi.fn(),
			onSave: vi.fn(),
			onPrepare
		});

		await expect.element(screen.getByText('Prepare before running agents')).toBeInTheDocument();
		await screen.getByRole('button', { name: /prepare environment/i }).click();
		expect(onPrepare).toHaveBeenCalledWith({ projectId: 'p1', profileId: 'env1', force: false });
	});

	it('does not enqueue prepare while prepare is already running', async () => {
		const onPrepare = vi.fn().mockResolvedValue({});
		const screen = render(ProjectSetupChecklist, {
			projectId: 'p1',
			project,
			environment: env({ lastPrepareStatus: 'running' }),
			prepareEvents: [],
			onDetect: vi.fn(),
			onSave: vi.fn(),
			onPrepare
		});

		const button = screen.getByRole('button', { name: /preparing environment/i });
		await expect.element(button).toBeDisabled();
		await button.click({ force: true });
		expect(onPrepare).not.toHaveBeenCalled();
	});

	it('allows opening the project when prepare is optional', async () => {
		const screen = render(ProjectSetupChecklist, {
			projectId: 'p1',
			project,
			environment: env({ installCommand: '', lastPrepareStatus: 'never' }),
			prepareEvents: [],
			onDetect: vi.fn(),
			onSave: vi.fn(),
			onPrepare: vi.fn()
		});

		await expect
			.element(screen.getByRole('link', { name: /open project/i }))
			.toHaveAttribute('href', '/projects/p1');
		await expect.element(screen.getByText('No install command required')).toBeInTheDocument();
	});

	it('shows live prepare log lines', async () => {
		const screen = render(ProjectSetupChecklist, {
			projectId: 'p1',
			project,
			environment: env({ lastPrepareStatus: 'running' }),
			prepareEvents: [{ id: 'event1', seq: 1, type: 'output', payload: { text: 'bun install' } }],
			onDetect: vi.fn(),
			onSave: vi.fn(),
			onPrepare: vi.fn()
		});

		await expect.element(screen.getByText('bun install')).toBeInTheDocument();
	});
});
