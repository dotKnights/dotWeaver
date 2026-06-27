import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ProjectEnvironmentServicesPanel from '$lib/components/projects/ProjectEnvironmentServicesPanel.svelte';

describe('ProjectEnvironmentServicesPanel', () => {
	it('adds postgres and redis services', async () => {
		const onCreate = vi.fn().mockResolvedValue({ id: 'svc1' });
		const screen = render(ProjectEnvironmentServicesPanel, {
			projectId: 'p1',
			profileId: 'env1',
			services: [],
			onCreate,
			onProvision: vi.fn(),
			onSetEnabled: vi.fn(),
			onUpdateEnvMappings: vi.fn()
		});

		await screen.getByRole('button', { name: /add postgres/i }).click();
		await screen.getByRole('button', { name: /add redis/i }).click();

		expect(onCreate).toHaveBeenCalledWith({
			projectId: 'p1',
			profileId: 'env1',
			kind: 'postgres'
		});
		expect(onCreate).toHaveBeenCalledWith({
			projectId: 'p1',
			profileId: 'env1',
			kind: 'redis'
		});
	});

	it('renders service status and masked sensitive outputs', async () => {
		const screen = render(ProjectEnvironmentServicesPanel, {
			projectId: 'p1',
			profileId: 'env1',
			services: [
				{
					id: 'svc1',
					kind: 'postgres',
					name: 'primary-db',
					enabled: true,
					status: 'ready',
					outputs: [
						{ key: 'DATABASE_URL', sensitive: true },
						{ key: 'POSTGRES_HOST', value: 'host', sensitive: false }
					]
				}
			],
			onCreate: vi.fn(),
			onProvision: vi.fn(),
			onSetEnabled: vi.fn(),
			onUpdateEnvMappings: vi.fn()
		});

		await expect.element(screen.getByText('primary-db')).toBeInTheDocument();
		await expect.element(screen.getByText('ready')).toBeInTheDocument();
		await expect.element(screen.getByText('DATABASE_URL')).toBeInTheDocument();
		await expect.element(screen.getByText('masked')).toBeInTheDocument();
		await expect.element(screen.getByText('POSTGRES_HOST')).toBeInTheDocument();
		await expect.element(screen.getByText(/^host$/)).toBeInTheDocument();
	});

	it('renders streamed service events', async () => {
		const screen = render(ProjectEnvironmentServicesPanel, {
			projectId: 'p1',
			profileId: 'env1',
			services: [
				{
					id: 'svc1',
					kind: 'postgres',
					name: 'primary-db',
					enabled: true,
					status: 'provisioning'
				}
			],
			serviceEvents: (serviceId) =>
				serviceId === 'svc1'
					? [
							{
								id: 'event1',
								seq: 1,
								type: 'system',
								payload: { text: 'Provisioning postgres service primary-db' }
							},
							{
								id: 'event2',
								seq: 2,
								type: 'output',
								payload: { text: 'database system is ready to accept connections' }
							}
						]
					: [],
			onCreate: vi.fn(),
			onProvision: vi.fn(),
			onSetEnabled: vi.fn(),
			onUpdateEnvMappings: vi.fn()
		});

		await expect.element(screen.getByText('Service log')).toBeInTheDocument();
		await expect
			.element(screen.getByText('Provisioning postgres service primary-db'))
			.toBeInTheDocument();
		await expect
			.element(screen.getByText('database system is ready to accept connections'))
			.toBeInTheDocument();
	});

	it('edits and saves service env mappings', async () => {
		const onUpdateEnvMappings = vi.fn().mockResolvedValue({ updated: true });
		const screen = render(ProjectEnvironmentServicesPanel, {
			projectId: 'p1',
			profileId: 'env1',
			services: [
				{
					id: 'svc1',
					kind: 'postgres',
					name: 'database',
					enabled: true,
					status: 'ready',
					envMappings: [
						{ key: 'DATABASE_URL', template: '${url}', enabled: true, sensitive: 'auto' }
					],
					sourceFields: [
						{ key: 'url', sensitive: true, hasValue: true },
						{ key: 'host', value: 'db.internal', sensitive: false },
						{ key: 'port', value: '5432', sensitive: false }
					],
					outputs: [{ key: 'DATABASE_URL', sensitive: true, hasValue: true }]
				}
			],
			onCreate: vi.fn(),
			onProvision: vi.fn(),
			onSetEnabled: vi.fn(),
			onUpdateEnvMappings
		});

		await expect.element(screen.getByText('Environment variables')).toBeInTheDocument();
		await expect.element(screen.getByText('DATABASE_URL').first()).toBeInTheDocument();
		await expect.element(screen.getByText('${url}')).toBeInTheDocument();

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

		expect(onUpdateEnvMappings).toHaveBeenCalledWith({
			projectId: 'p1',
			profileId: 'env1',
			serviceId: 'svc1',
			envMappings: [
				{ key: 'DATABASE_URL', template: '${url}', enabled: true, sensitive: 'auto' },
				{ key: 'DIRECT_URL', template: '${url}', enabled: true, sensitive: 'auto' }
			]
		});
		await expect.element(screen.getByText('DIRECT_URL')).toBeInTheDocument();
	});

	it('preserves editable enabled and sensitivity flags when saving mappings', async () => {
		const onUpdateEnvMappings = vi.fn().mockResolvedValue({ updated: true });
		const screen = render(ProjectEnvironmentServicesPanel, {
			projectId: 'p1',
			profileId: 'env1',
			services: [
				{
					id: 'svc1',
					kind: 'postgres',
					name: 'database',
					enabled: true,
					status: 'ready',
					envMappings: [
						{
							key: 'POSTGRES_HOST',
							template: '${host}',
							enabled: false,
							sensitive: false
						}
					],
					sourceFields: [{ key: 'host', value: 'db.internal', sensitive: false }]
				}
			],
			onCreate: vi.fn(),
			onProvision: vi.fn(),
			onSetEnabled: vi.fn(),
			onUpdateEnvMappings
		});

		await expect.element(screen.getByLabelText('Enabled')).not.toBeChecked();
		await expect.element(screen.getByLabelText('Sensitivity 1')).toHaveTextContent('Not sensitive');

		await screen.getByRole('button', { name: /save variables/i }).click();

		expect(onUpdateEnvMappings).toHaveBeenCalledWith({
			projectId: 'p1',
			profileId: 'env1',
			serviceId: 'svc1',
			envMappings: [{ key: 'POSTGRES_HOST', template: '${host}', enabled: false, sensitive: false }]
		});
	});
});
