import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ProjectPage from '../../../src/routes/(app)/projects/[id]/+page.svelte';

const mocks = vi.hoisted(() => ({
	startRun: vi.fn()
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
	})),
	getProjectCapabilities: vi.fn(() => ({
		current: {
			'project.view': true,
			'project.manage_access': true,
			'project.config.view': true,
			'project.config.manage': true,
			'run.view': true,
			'run.create': true,
			'run.reply': true,
			'run.diff.view': true,
			'run.approve': true
		},
		error: undefined
	})),
	listProjectBranches: vi.fn(() => ({ current: ['main'], error: undefined }))
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

vi.mock('$lib/rfc/project-agent-config.remote', () => ({
	getProjectAgentConfig: vi.fn(() => ({ current: undefined, error: undefined })),
	searchSkillsSh: vi.fn(() => ({ current: { skills: [] }, error: undefined })),
	getSkillsShSkill: vi.fn(() => ({ current: null, error: undefined })),
	upsertProjectMcpServer: vi.fn(),
	upsertProjectSkill: vi.fn(),
	importSkillsShSkill: vi.fn(),
	upsertProjectSecret: vi.fn(),
	upsertProjectEnvVar: vi.fn(),
	deleteProjectEnvVar: vi.fn(),
	setProjectEnvVarEnabled: vi.fn(),
	setProjectEnvVarSensitive: vi.fn(),
	revealProjectEnvVar: vi.fn(),
	importProjectEnvFile: vi.fn(),
	deleteProjectMcpServer: vi.fn(),
	deleteProjectSkill: vi.fn(),
	deleteProjectSecret: vi.fn(),
	setProjectMcpServerEnabled: vi.fn(),
	setProjectSkillEnabled: vi.fn(),
	importProjectMcpJson: vi.fn()
}));

vi.mock('$lib/rfc/project-environments.remote', () => ({
	getProjectEnvironment: vi.fn(() => ({ current: null, error: undefined })),
	getProjectEnvironmentPrepareEvents: vi.fn(() => ({ current: [], error: undefined })),
	detectProjectEnvironment: vi.fn(async () => ({ id: 'env1' })),
	saveProjectEnvironment: vi.fn(async () => ({ id: 'env1' })),
	prepareProjectEnvironment: vi.fn(async () => ({ queued: true }))
}));

vi.mock('$lib/rfc/runs.remote', () => ({
	listRuns: vi.fn(() => ({ current: [], error: undefined })),
	startRun: mocks.startRun
}));

describe('project page setup gate', () => {
	beforeEach(() => {
		mocks.startRun.mockReset();
	});

	it('does not start a run while project setup is incomplete', async () => {
		const screen = render(ProjectPage);

		await expect.element(screen.getByText('Project setup is not complete.')).toBeInTheDocument();
		await screen.getByPlaceholder(/Describe what the agent should do/).fill('ship it');

		const runButton = screen.getByRole('button', { name: /^run$/i });
		await expect.element(runButton).toBeDisabled();
		await runButton.click({ force: true });

		expect(mocks.startRun).not.toHaveBeenCalled();
	});
});
