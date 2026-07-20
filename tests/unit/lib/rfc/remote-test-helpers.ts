import { vi } from 'vitest';

type RemoteHandler = (...args: never[]) => unknown;
type RemoteMetadata<TType extends 'command' | 'query'> = { __: { type: TType } };

export type RemoteCommandMock<THandler extends RemoteHandler> = THandler &
	RemoteMetadata<'command'>;

export type RefreshableRemoteCommandMock<THandler extends RemoteHandler> =
	RemoteCommandMock<THandler> & {
		refresh: () => Promise<void>;
	};

export type RemoteQueryMock<THandler extends RemoteHandler, TClient> = ((
	...args: unknown[]
) => TClient) &
	RemoteMetadata<'query'> & {
		serverHandler: THandler;
	};

export function mockRemoteCommand<THandler extends RemoteHandler>(
	handler: THandler
): RemoteCommandMock<THandler> {
	const wrapped = vi.fn(handler) as unknown as RemoteCommandMock<THandler>;
	wrapped.__ = { type: 'command' };
	return wrapped;
}

export function mockRefreshableRemoteCommand<THandler extends RemoteHandler>(
	handler: THandler,
	refresh: () => Promise<void> = async () => undefined
): RefreshableRemoteCommandMock<THandler> {
	const wrapped = mockRemoteCommand(handler) as RefreshableRemoteCommandMock<THandler>;
	wrapped.refresh = vi.fn(refresh);
	return wrapped;
}

function mockRemoteQuery<THandler extends RemoteHandler, TClient>(
	handler: THandler,
	createClient: (...args: unknown[]) => TClient
): RemoteQueryMock<THandler, TClient> {
	const wrapped = vi.fn((...args: unknown[]) =>
		createClient(...args)
	) as unknown as RemoteQueryMock<THandler, TClient>;
	wrapped.__ = { type: 'query' };
	wrapped.serverHandler = handler;
	return wrapped;
}

export function mockRemoteQueryWithRefresh<THandler extends RemoteHandler>(
	handler: THandler,
	refresh: () => Promise<void>
): RemoteQueryMock<THandler, { refresh: () => Promise<void> }> {
	return mockRemoteQuery(handler, () => ({ refresh }));
}

function mockRemoteQueryWithTrackedRefresh<THandler extends RemoteHandler>(
	handler: THandler,
	queryRefreshes: unknown[],
	refresh: (arg: unknown) => Promise<void>
): RemoteQueryMock<THandler, { refresh: () => Promise<void> }> {
	return mockRemoteQuery(handler, (arg) => ({
		refresh: vi.fn(async () => {
			queryRefreshes.push(arg);
			await refresh(arg);
		})
	}));
}

export function mockRemoteQueryState<THandler extends RemoteHandler>(
	handler: THandler,
	refresh: () => Promise<void> = async () => undefined
): RemoteQueryMock<
	THandler,
	{ current: undefined; error: undefined; refresh: () => Promise<void> }
> {
	return mockRemoteQuery(handler, () => ({
		current: undefined,
		error: undefined,
		refresh: vi.fn(refresh)
	}));
}

export function mockAppServerWithRefreshableCommands(input: { getRequestEvent: unknown }) {
	return {
		command: vi.fn((schemaOrHandler, maybeHandler) =>
			mockRefreshableRemoteCommand(maybeHandler ?? schemaOrHandler)
		),
		query: vi.fn((schemaOrHandler, maybeHandler) =>
			mockRemoteQueryState(maybeHandler ?? schemaOrHandler)
		),
		getRequestEvent: input.getRequestEvent
	};
}

export function mockAppServerWithTrackedRefresh(input: {
	getRequestEvent: unknown;
	queryRefreshes: unknown[];
	refresh: (arg: unknown) => Promise<void>;
}) {
	return {
		command: vi.fn((schemaOrHandler, maybeHandler) =>
			mockRemoteCommand(maybeHandler ?? schemaOrHandler)
		),
		query: vi.fn((schemaOrHandler, maybeHandler) =>
			mockRemoteQueryWithTrackedRefresh(
				maybeHandler ?? schemaOrHandler,
				input.queryRefreshes,
				input.refresh
			)
		),
		getRequestEvent: input.getRequestEvent
	};
}
