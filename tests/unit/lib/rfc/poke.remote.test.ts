import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	getRequestEvent: vi.fn(),
	queryRefresh: vi.fn(),
	getUserPokeConfig: vi.fn(),
	upsertUserPokeApiKey: vi.fn(),
	setUserPokeEnabled: vi.fn(),
	deleteUserPokeConfig: vi.fn(),
	PokeConfigError: class PokeConfigError extends Error {
		constructor(message: string) {
			super(message);
			this.name = 'PokeConfigError';
		}
	}
}));

function remoteCommand<T extends (...args: never[]) => unknown>(handler: T): T {
	const wrapped = vi.fn(handler) as unknown as T & { __: { type: 'command' } };
	wrapped.__ = { type: 'command' };
	return wrapped;
}

function remoteQuery<T extends (...args: never[]) => unknown>(
	handler: T
): (() => { refresh: () => Promise<void> }) & { __: { type: 'query' }; serverHandler: T } {
	const wrapped = vi.fn(() => ({
		refresh: mocks.queryRefresh
	})) as unknown as (() => { refresh: () => Promise<void> }) & {
		__: { type: 'query' };
		serverHandler: T;
	};
	wrapped.__ = { type: 'query' };
	wrapped.serverHandler = handler;
	return wrapped;
}

vi.mock('$app/server', () => ({
	command: vi.fn((schemaOrHandler, maybeHandler) => remoteCommand(maybeHandler ?? schemaOrHandler)),
	query: vi.fn((schemaOrHandler, maybeHandler) => remoteQuery(maybeHandler ?? schemaOrHandler)),
	getRequestEvent: mocks.getRequestEvent
}));

vi.mock('@sveltejs/kit', () => ({
	error: vi.fn((status: number, message: string) => {
		throw Object.assign(new Error(message), { status });
	})
}));

vi.mock('$lib/server/poke-service', () => ({
	deleteUserPokeConfig: mocks.deleteUserPokeConfig,
	getUserPokeConfig: mocks.getUserPokeConfig,
	PokeConfigError: mocks.PokeConfigError,
	setUserPokeEnabled: mocks.setUserPokeEnabled,
	upsertUserPokeApiKey: mocks.upsertUserPokeApiKey
}));

import {
	deletePokeConnector,
	getPokeConnector,
	savePokeApiKey,
	setPokeEnabled
} from '$lib/rfc/poke.remote';

const getPokeConnectorServer = getPokeConnector as typeof getPokeConnector & {
	serverHandler: () => ReturnType<typeof getPokeConnector>;
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

	it('saves the current user Poke API key and refreshes the connector query', async () => {
		const connector = {
			connected: true,
			enabled: true,
			lastNotifiedAt: null,
			lastError: null
		};
		mocks.upsertUserPokeApiKey.mockResolvedValue(connector);
		mocks.queryRefresh.mockResolvedValue(undefined);

		await expect(savePokeApiKey({ apiKey: 'pk_live' })).resolves.toEqual(connector);

		expect(mocks.upsertUserPokeApiKey).toHaveBeenCalledWith('user1', 'pk_live');
		expect(mocks.queryRefresh).toHaveBeenCalled();
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
		mocks.upsertUserPokeApiKey.mockRejectedValue(
			new mocks.PokeConfigError('Poke API key is required')
		);

		await expect(savePokeApiKey({ apiKey: ' ' })).rejects.toMatchObject({
			status: 400,
			message: 'Poke API key is required'
		});
	});

	it('rejects unauthenticated calls', async () => {
		mocks.getRequestEvent.mockReturnValue({ locals: {} });

		await expect(getPokeConnectorServer.serverHandler()).rejects.toMatchObject({
			status: 401,
			message: 'Not authenticated'
		});
	});
});
