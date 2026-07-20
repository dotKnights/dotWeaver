import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ProjectsPage from '../../../src/routes/(app)/projects/+page.svelte';

const mocks = vi.hoisted(() => ({
	goto: vi.fn(),
	importProject: vi.fn()
}));

vi.mock('$app/navigation', () => ({
	goto: mocks.goto
}));

vi.mock('$lib/rfc/projects.remote', () => ({
	listProjects: vi.fn(() => ({ current: [], error: undefined })),
	listGithubRepos: vi.fn(() => ({
		current: {
			connected: true,
			repos: [
				{
					githubRepoId: 1,
					owner: 'acme',
					name: 'repo',
					fullName: 'acme/repo',
					defaultBranch: 'main',
					private: false
				}
			]
		},
		error: undefined
	})),
	importProject: mocks.importProject
}));

vi.mock('$lib/rfc/teams.remote', () => ({
	listMyTeams: vi.fn(() => ({
		current: {
			teams: [{ id: 'org1', name: 'Acme' }],
			activeOrganizationId: 'org1',
			hasInternalTeams: true,
			hasClientAccess: false
		},
		error: undefined
	}))
}));

describe('projects page', () => {
	beforeEach(() => {
		mocks.goto.mockReset();
		mocks.importProject.mockReset();
	});

	it('redirects to setup after importing a GitHub repository', async () => {
		mocks.importProject.mockResolvedValue({ id: 'p1', owner: 'acme', name: 'repo' });
		const screen = render(ProjectsPage);

		await screen.getByRole('button', { name: 'Import repository' }).first().click();
		await screen.getByRole('button', { name: 'Import', exact: true }).click();

		expect(mocks.importProject).toHaveBeenCalledWith({ owner: 'acme', name: 'repo' });
		expect(mocks.goto).toHaveBeenCalledWith('/projects/p1/setup');
	});
});
