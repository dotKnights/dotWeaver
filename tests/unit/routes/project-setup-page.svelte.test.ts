import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import SetupPage from '../../../src/routes/(app)/projects/[id]/setup/+page.svelte';

const mocks = vi.hoisted(() => ({
	detectProjectEnvironment: vi.fn(),
	saveProjectEnvironment: vi.fn(),
	prepareProjectEnvironment: vi.fn()
}));

vi.mock('$app/state', () => ({
	page: {
		params: {
			id: 'p1'
		}
	}
}));

vi.mock('$lib/rfc/projects.remote', () => ({
	getProject: vi.fn(() => ({
		current: {
			id: 'p1',
			owner: 'acme',
			name: 'repo',
			defaultBranch: 'main',
			private: false
		},
		error: undefined
	}))
}));

vi.mock('$lib/rfc/project-environments.remote', () => ({
	getProjectEnvironment: vi.fn(() => ({ current: null, error: undefined })),
	getProjectEnvironmentPrepareEvents: vi.fn(() => ({ current: [], error: undefined })),
	detectProjectEnvironment: mocks.detectProjectEnvironment,
	saveProjectEnvironment: mocks.saveProjectEnvironment,
	prepareProjectEnvironment: mocks.prepareProjectEnvironment
}));

describe('project setup page', () => {
	it('renders project setup checklist for a project without an environment', async () => {
		const screen = render(SetupPage);

		await expect.element(screen.getByText('Setup acme/repo')).toBeInTheDocument();
		await expect
			.element(screen.getByRole('button', { name: /detect environment/i }))
			.toBeInTheDocument();
	});
});
