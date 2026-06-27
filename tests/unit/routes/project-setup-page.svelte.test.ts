import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import SetupPage from '../../../src/routes/(app)/projects/[id]/setup/+page.svelte';

const mocks = vi.hoisted(() => ({
	getProjectEnvironment: vi.fn(),
	detectProjectEnvironment: vi.fn(),
	saveProjectEnvironment: vi.fn(),
	prepareProjectEnvironment: vi.fn(),
	getProjectEnvironmentServices: vi.fn(),
	createProjectEnvironmentService: vi.fn(),
	provisionProjectEnvironmentService: vi.fn(),
	setProjectEnvironmentServiceEnabled: vi.fn(),
	updateProjectEnvironmentServiceEnvMappings: vi.fn()
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
	getProjectEnvironment: mocks.getProjectEnvironment,
	getProjectEnvironmentPrepareEvents: vi.fn(() => ({ current: [], error: undefined })),
	detectProjectEnvironment: mocks.detectProjectEnvironment,
	saveProjectEnvironment: mocks.saveProjectEnvironment,
	prepareProjectEnvironment: mocks.prepareProjectEnvironment
}));

vi.mock('$lib/rfc/project-environment-services.remote', () => ({
	getProjectEnvironmentServices: mocks.getProjectEnvironmentServices,
	createProjectEnvironmentService: mocks.createProjectEnvironmentService,
	provisionProjectEnvironmentService: mocks.provisionProjectEnvironmentService,
	setProjectEnvironmentServiceEnabled: mocks.setProjectEnvironmentServiceEnabled,
	updateProjectEnvironmentServiceEnvMappings: mocks.updateProjectEnvironmentServiceEnvMappings
}));

describe('project setup page', () => {
	beforeEach(() => {
		mocks.getProjectEnvironment.mockReturnValue({ current: null, error: undefined });
		mocks.getProjectEnvironmentServices.mockReturnValue({ current: [], error: undefined });
		mocks.updateProjectEnvironmentServiceEnvMappings.mockResolvedValue({ updated: true });
	});

	it('renders project setup checklist for a project without an environment', async () => {
		const screen = render(SetupPage);

		await expect.element(screen.getByText('Setup acme/repo')).toBeInTheDocument();
		await expect
			.element(screen.getByRole('button', { name: /detect environment/i }))
			.toBeInTheDocument();
	});

	it('wires service env mapping updates through the setup page', async () => {
		mocks.getProjectEnvironment.mockReturnValue({
			current: {
				id: 'env1',
				status: 'ready',
				runtime: 'node',
				packageManager: 'bun',
				installCommand: 'bun install',
				currentFingerprint: 'fp1',
				lastPreparedFingerprint: 'fp1',
				lastPrepareStatus: 'succeeded'
			},
			error: undefined
		});
		mocks.getProjectEnvironmentServices.mockReturnValue({
			current: [
				{
					id: 'svc1',
					kind: 'postgres',
					name: 'database',
					enabled: true,
					status: 'ready',
					envMappings: [
						{ key: 'DATABASE_URL', template: '${url}', enabled: true, sensitive: 'auto' }
					],
					sourceFields: [{ key: 'url', sensitive: true, hasValue: true }],
					outputs: [{ key: 'DATABASE_URL', sensitive: true, hasValue: true }]
				}
			],
			error: undefined
		});

		const screen = render(SetupPage);

		await screen.getByRole('button', { name: /add variable/i }).click();
		await screen
			.getByLabelText(/variable name/i)
			.last()
			.fill('DIRECT_URL');
		await screen
			.getByLabelText(/template/i)
			.last()
			.fill('${url}');
		await screen.getByRole('button', { name: /save variables/i }).click();

		expect(mocks.updateProjectEnvironmentServiceEnvMappings).toHaveBeenCalledWith({
			projectId: 'p1',
			profileId: 'env1',
			serviceId: 'svc1',
			envMappings: [
				{ key: 'DATABASE_URL', template: '${url}', enabled: true, sensitive: 'auto' },
				{ key: 'DIRECT_URL', template: '${url}', enabled: true, sensitive: 'auto' }
			]
		});
	});
});
