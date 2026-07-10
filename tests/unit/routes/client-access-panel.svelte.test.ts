import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ClientAccessPanel from '../../../src/lib/components/clients/ClientAccessPanel.svelte';

const mocks = vi.hoisted(() => ({
	clientsQuery: {
		current: [
			{
				id: 'client1',
				name: 'Acme',
				members: [
					{
						id: 'member1',
						role: 'member',
						user: { name: 'Client User', email: 'client@example.com' }
					}
				]
			}
		],
		error: undefined,
		refresh: vi.fn()
	},
	accessQuery: {
		current: [
			{
				id: 'grant1',
				subjectType: 'client_organization',
				subjectId: 'client1',
				permissions: ['project.view', 'run.view', 'run.diff.view', 'run.reply']
			}
		],
		error: undefined,
		refresh: vi.fn()
	},
	listClients: vi.fn(),
	getProjectAccess: vi.fn(),
	upsertProjectAccess: vi.fn(),
	removeProjectAccess: vi.fn()
}));

vi.mock('$lib/rfc/client-access.remote', () => ({
	listClients: mocks.listClients,
	getProjectAccess: mocks.getProjectAccess,
	upsertProjectAccess: mocks.upsertProjectAccess,
	removeProjectAccess: mocks.removeProjectAccess
}));

function changeSelect(index: number, value: string) {
	const select = document.querySelectorAll('select').item(index) as HTMLSelectElement | null;
	if (!select) throw new Error(`Missing select ${index}`);
	select.value = value;
	select.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('client access panel', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.clientsQuery.refresh.mockResolvedValue(undefined);
		mocks.accessQuery.refresh.mockResolvedValue(undefined);
		mocks.listClients.mockReturnValue(mocks.clientsQuery);
		mocks.getProjectAccess.mockReturnValue(mocks.accessQuery);
		mocks.upsertProjectAccess.mockResolvedValue({ id: 'grant1' });
		mocks.removeProjectAccess.mockResolvedValue({ removed: true });
		document.body.innerHTML = '';
	});

	it('renders existing client grants with preset and permission labels', async () => {
		const screen = render(ClientAccessPanel, { projectId: 'p1', canManageAccess: true });

		await expect.element(screen.getByText('Client access')).toBeInTheDocument();
		expect(document.body.textContent).toContain('Acme');
		expect(document.body.textContent).toContain('Reviewer');
		expect(document.body.textContent).toContain('View runs');
		expect(document.body.textContent).toContain('Reply to runs');
		expect(mocks.getProjectAccess).toHaveBeenCalledWith('p1');
	});

	it('grants a selected preset to a client organization', async () => {
		const screen = render(ClientAccessPanel, { projectId: 'p1', canManageAccess: true });

		changeSelect(0, 'client_organization:client1');
		changeSelect(1, 'operator');
		await screen.getByRole('button', { name: /Grant access/ }).click();

		expect(mocks.upsertProjectAccess).toHaveBeenCalledWith({
			projectId: 'p1',
			subjectType: 'client_organization',
			subjectId: 'client1',
			preset: 'operator'
		});
		expect(mocks.accessQuery.refresh).toHaveBeenCalled();
	});
});
