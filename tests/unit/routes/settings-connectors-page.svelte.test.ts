import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ConnectorsPage from '../../../src/routes/(app)/settings/connectors/+page.svelte';

vi.mock('$lib/auth-client', () => ({
	authClient: { linkSocial: vi.fn() }
}));

vi.mock('$lib/rfc/connectors.remote', () => ({
	listConnectors: vi.fn(() => ({
		current: {
			github: { connected: false, canDisconnect: false },
			google: {
				connected: false,
				canDisconnect: false,
				hasGmailScope: false,
				needsReconnect: false
			},
			hasPassword: true,
			githubOrgAccessUrl: 'https://github.com/settings/connections/applications/client'
		},
		refresh: vi.fn()
	})),
	disconnectGithub: vi.fn(),
	disconnectGoogle: vi.fn()
}));

vi.mock('$lib/rfc/poke.remote', () => ({
	getPokeConnector: vi.fn(() => ({
		current: {
			connected: true,
			enabled: true,
			lastNotifiedAt: new Date('2026-06-18T10:00:00.000Z'),
			lastError: 'Poke API returned 401'
		},
		refresh: vi.fn()
	})),
	savePokeApiKey: vi.fn(),
	setPokeEnabled: vi.fn(),
	deletePokeConnector: vi.fn()
}));

describe('settings connectors page', () => {
	it('renders the Poke connector controls', async () => {
		const screen = render(ConnectorsPage);

		await expect.element(screen.getByText('Poke', { exact: true })).toBeInTheDocument();
		await expect.element(screen.getByLabelText('Clé API Poke')).toBeInTheDocument();
		await expect.element(screen.getByText('Notifications Poke actives')).toBeInTheDocument();
		await expect.element(screen.getByText('Dernière notification Poke: Poke API returned 401')).toBeInTheDocument();
	});
});
