import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockRemoteCommand, mockRemoteQueryWithRefresh } from './remote-test-helpers';

const mocks = vi.hoisted(() => ({
	getRequestEvent: vi.fn(),
	queryRefresh: vi.fn(),
	getUserPokeConfig: vi.fn(),
	setUserPokeEnabled: vi.fn(),
	deleteUserPokeConfig: vi.fn(),
	getUserPokeLoginState: vi.fn(),
	startUserPokeLogin: vi.fn(),
	PokeConfigError: class PokeConfigError extends Error {
		constructor(message: string) {
			super(message);
			this.name = 'PokeConfigError';
		}
	}
}));

vi.mock('$app/server', () => ({
	command: vi.fn((schemaOrHandler, maybeHandler) =>
		mockRemoteCommand(maybeHandler ?? schemaOrHandler)
	),
	query: vi.fn((schemaOrHandler, maybeHandler) =>
		mockRemoteQueryWithRefresh(maybeHandler ?? schemaOrHandler, mocks.queryRefresh)
	),
	getRequestEvent: mocks.getRequestEvent
}));

vi.mock('@sveltejs/kit', () => ({
	error: vi.fn((status: number, message: string) => {
		throw Object.assign(new Error(message), { status });
	})
}));

vi.mock('$lib/server/integrations/poke/service', () => ({
	deleteUserPokeConfig: mocks.deleteUserPokeConfig,
	getUserPokeLoginState: mocks.getUserPokeLoginState,
	getUserPokeConfig: mocks.getUserPokeConfig,
	PokeConfigError: mocks.PokeConfigError,
	setUserPokeEnabled: mocks.setUserPokeEnabled,
	startUserPokeLogin: mocks.startUserPokeLogin
}));

import {
	deletePokeConnector,
	getPokeConnector,
	getPokeLoginState,
	setPokeEnabled,
	startPokeLogin
} from '$lib/rfc/poke.remote';

const getPokeConnectorServer = getPokeConnector as typeof getPokeConnector & {
	serverHandler: () => ReturnType<typeof getPokeConnector>;
};
const getPokeLoginStateServer = getPokeLoginState as typeof getPokeLoginState & {
	serverHandler: () => ReturnType<typeof getPokeLoginState>;
};

describe('poke.remote', () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.getRequestEvent.mockReturnValue({ locals: { user: { id: 'user1' } } });
	});

	it('reads the masked Poke connector for the current user', async () => {
		const connector = {
			connected: true,
			enabled: true,
			lastNotifiedAt: null,
			lastError: null
		};
		mocks.getUserPokeConfig.mockResolvedValue(connector);

		await expect(getPokeConnectorServer.serverHandler()).resolves.toEqual(connector);

		expect(mocks.getUserPokeConfig).toHaveBeenCalledWith('user1');
	});

	it('toggles the current user Poke connector and refreshes the query', async () => {
		const connector = {
			connected: true,
			enabled: false,
			lastNotifiedAt: null,
			lastError: null
		};
		mocks.setUserPokeEnabled.mockResolvedValue(connector);
		mocks.queryRefresh.mockResolvedValue(undefined);

		await expect(setPokeEnabled({ enabled: false })).resolves.toEqual(connector);

		expect(mocks.setUserPokeEnabled).toHaveBeenCalledWith('user1', false);
		expect(mocks.queryRefresh).toHaveBeenCalled();
	});

	it('deletes the current user Poke connector and refreshes the query', async () => {
		const connector = {
			connected: false,
			enabled: false,
			lastNotifiedAt: null,
			lastError: null
		};
		mocks.deleteUserPokeConfig.mockResolvedValue(connector);
		mocks.queryRefresh.mockResolvedValue(undefined);

		await expect(deletePokeConnector()).resolves.toEqual(connector);

		expect(mocks.deleteUserPokeConfig).toHaveBeenCalledWith('user1');
		expect(mocks.queryRefresh).toHaveBeenCalled();
	});

	it('maps Poke config errors to 400 responses', async () => {
		mocks.setUserPokeEnabled.mockRejectedValue(new mocks.PokeConfigError('Poke is not connected'));

		await expect(setPokeEnabled({ enabled: true })).rejects.toMatchObject({
			status: 400,
			message: 'Poke is not connected'
		});
	});

	it('reads the current user Poke login state', async () => {
		const state = { status: 'idle', loggedIn: false };
		mocks.getUserPokeLoginState.mockResolvedValue(state);

		await expect(getPokeLoginStateServer.serverHandler()).resolves.toEqual(state);

		expect(mocks.getUserPokeLoginState).toHaveBeenCalledWith('user1');
	});

	it('starts Poke SDK login for the current user and refreshes connector state', async () => {
		const state = {
			status: 'pending',
			loggedIn: false,
			userCode: 'ABCD-1234',
			loginUrl: 'https://poke.com/device?code=ABCD-1234'
		};
		mocks.startUserPokeLogin.mockResolvedValue(state);
		mocks.queryRefresh.mockResolvedValue(undefined);

		await expect(startPokeLogin()).resolves.toEqual(state);

		expect(mocks.startUserPokeLogin).toHaveBeenCalledWith('user1');
		expect(mocks.queryRefresh).toHaveBeenCalled();
	});

	it('rejects unauthenticated calls', async () => {
		mocks.getRequestEvent.mockReturnValue({ locals: {} });

		await expect(getPokeConnectorServer.serverHandler()).rejects.toMatchObject({
			status: 401,
			message: 'Not authenticated'
		});
	});
});
