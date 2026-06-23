import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ConnectorsPage from '../../../src/routes/(app)/settings/connectors/+page.svelte';

const pokeMocks = vi.hoisted(() => ({
	connectorQuery: {
		current: {
			connected: false,
			enabled: false,
			lastNotifiedAt: null,
			lastError: null
		},
		refresh: vi.fn()
	},
	loginQuery: {
		current: {
			status: 'idle',
			loggedIn: false
		} as
			| { status: 'idle'; loggedIn: false }
			| { status: 'pending'; loggedIn: false; userCode: string; loginUrl: string }
			| { status: 'connected'; loggedIn: true }
			| { status: 'failed'; loggedIn: false; error: string },
		refresh: vi.fn()
	},
	getPokeConnectorRefresh: vi.fn(),
	getPokeLoginStateRefresh: vi.fn(),
	startPokeLogin: vi.fn(),
	setPokeEnabled: vi.fn(),
	deletePokeConnector: vi.fn()
}));

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
	getPokeConnector: vi.fn(() => pokeMocks.connectorQuery),
	getPokeLoginState: vi.fn(() => pokeMocks.loginQuery),
	startPokeLogin: pokeMocks.startPokeLogin,
	setPokeEnabled: pokeMocks.setPokeEnabled,
	deletePokeConnector: pokeMocks.deletePokeConnector
}));

describe('settings connectors page', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		pokeMocks.connectorQuery.current = {
			connected: false,
			enabled: false,
			lastNotifiedAt: null,
			lastError: null
		};
		pokeMocks.loginQuery.current = {
			status: 'idle',
			loggedIn: false
		};
		pokeMocks.connectorQuery.refresh = pokeMocks.getPokeConnectorRefresh;
		pokeMocks.loginQuery.refresh = pokeMocks.getPokeLoginStateRefresh;
		pokeMocks.getPokeConnectorRefresh.mockResolvedValue(undefined);
		pokeMocks.getPokeLoginStateRefresh.mockResolvedValue(undefined);
	});

	it('renders the Poke SDK login controls without the manual API key input', async () => {
		const screen = render(ConnectorsPage);

		await expect.element(screen.getByText('Poke', { exact: true })).toBeInTheDocument();
		await expect
			.element(screen.getByRole('button', { name: 'Connecter Poke' }))
			.toBeInTheDocument();
		await expect.element(screen.getByLabelText('Clé API Poke')).not.toBeInTheDocument();
	});

	it('starts the Poke SDK login flow and shows the device code', async () => {
		pokeMocks.startPokeLogin.mockResolvedValue({
			status: 'pending',
			loggedIn: false,
			userCode: 'ABCD-1234',
			loginUrl: 'https://poke.com/device?code=ABCD-1234'
		});
		const screen = render(ConnectorsPage);

		await screen.getByRole('button', { name: 'Connecter Poke' }).click();

		expect(pokeMocks.startPokeLogin).toHaveBeenCalled();
		await expect.element(screen.getByText('ABCD-1234')).toBeInTheDocument();
		await expect
			.element(screen.getByRole('link', { name: 'Ouvrir le login Poke' }))
			.toHaveAttribute('href', 'https://poke.com/device?code=ABCD-1234');
	});

	it('automatically resyncs a pending Poke login when the page mounts and regains focus', async () => {
		pokeMocks.loginQuery.current = {
			status: 'pending',
			loggedIn: false,
			userCode: 'ABCD-1234',
			loginUrl: 'https://poke.com/device?code=ABCD-1234'
		};

		render(ConnectorsPage);

		await vi.waitFor(() => expect(pokeMocks.getPokeConnectorRefresh).toHaveBeenCalledTimes(1));
		expect(pokeMocks.getPokeLoginStateRefresh).toHaveBeenCalledTimes(1);
		await new Promise((resolve) => window.setTimeout(resolve, 0));

		pokeMocks.getPokeConnectorRefresh.mockClear();
		pokeMocks.getPokeLoginStateRefresh.mockClear();
		window.dispatchEvent(new Event('focus'));

		await vi.waitFor(() => expect(pokeMocks.getPokeConnectorRefresh).toHaveBeenCalledTimes(1));
		expect(pokeMocks.getPokeLoginStateRefresh).toHaveBeenCalledTimes(1);
	});
});
