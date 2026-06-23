import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
	class CdcDocumentServiceError extends Error {
		constructor(message: string) {
			super(message);
			this.name = 'CdcDocumentServiceError';
		}
	}

	return {
		getRequestEvent: vi.fn(),
		requireHeaders: vi.fn(),
		requireActiveOrg: vi.fn(),
		listCdcDocumentsRefresh: vi.fn(),
		getRunRefresh: vi.fn(),
		listCdcDocumentsForOrg: vi.fn(),
		getCdcDocumentForOrg: vi.fn(),
		validateRunCdcForOrg: vi.fn(),
		CdcDocumentServiceError
	};
});

function remoteCommand<T extends (...args: never[]) => unknown>(handler: T): T {
	const wrapped = vi.fn(handler) as unknown as T & { __: { type: 'command' } };
	wrapped.__ = { type: 'command' };
	return wrapped;
}

function remoteQuery<T extends (arg: never) => unknown>(
	handler: T,
	refreshForArg?: (arg: Parameters<T>[0]) => () => Promise<void>
): ((arg: Parameters<T>[0]) => { refresh: () => Promise<void> }) & {
	__: { type: 'query' };
	serverHandler: T;
} {
	const wrapped = vi.fn((arg: Parameters<T>[0]) => ({
		refresh: refreshForArg?.(arg) ?? vi.fn(async () => undefined)
	})) as unknown as ((arg: Parameters<T>[0]) => { refresh: () => Promise<void> }) & {
		__: { type: 'query' };
		serverHandler: T;
	};
	wrapped.__ = { type: 'query' };
	wrapped.serverHandler = handler;
	return wrapped;
}

vi.mock('$app/server', () => ({
	command: vi.fn((schemaOrHandler, maybeHandler) => remoteCommand(maybeHandler ?? schemaOrHandler)),
	query: vi.fn((schemaOrHandler, maybeHandler) => {
		const handler = maybeHandler ?? schemaOrHandler;
		return remoteQuery(handler, () => mocks.listCdcDocumentsRefresh);
	}),
	getRequestEvent: mocks.getRequestEvent
}));

vi.mock('@sveltejs/kit', () => ({
	error: vi.fn((status: number, message: string) => {
		throw Object.assign(new Error(message), { status });
	})
}));

vi.mock('$lib/server/utils', () => ({ requireHeaders: mocks.requireHeaders }));
vi.mock('$lib/server/org', () => ({ requireActiveOrg: mocks.requireActiveOrg }));
vi.mock('$lib/server/cdc-documents-service', () => ({
	listCdcDocumentsForOrg: mocks.listCdcDocumentsForOrg,
	getCdcDocumentForOrg: mocks.getCdcDocumentForOrg,
	validateRunCdcForOrg: mocks.validateRunCdcForOrg,
	CdcDocumentServiceError: mocks.CdcDocumentServiceError
}));
vi.mock('$lib/rfc/runs.remote', () => ({
	getRun: vi.fn(() => ({ refresh: mocks.getRunRefresh }))
}));

import { getRun } from '$lib/rfc/runs.remote';
import { getCdcDocument, listCdcDocuments, validateRunCdc } from '$lib/rfc/cdc-documents.remote';

const listCdcDocumentsServer = listCdcDocuments as typeof listCdcDocuments & {
	serverHandler: (projectId: string) => Promise<unknown>;
};
const getCdcDocumentServer = getCdcDocument as typeof getCdcDocument & {
	serverHandler: (id: string) => Promise<unknown>;
};

describe('cdc-documents.remote', () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.requireHeaders.mockReturnValue(new Headers());
		mocks.requireActiveOrg.mockResolvedValue('org_1');
		mocks.getRequestEvent.mockReturnValue({ locals: { user: { id: 'user_1' } } });
		mocks.listCdcDocumentsRefresh.mockResolvedValue(undefined);
		mocks.getRunRefresh.mockResolvedValue(undefined);
	});

	it('lists CDC documents for the active organization', async () => {
		const documents = [{ id: 'cdc_1', version: 1 }];
		mocks.listCdcDocumentsForOrg.mockResolvedValue(documents);

		await expect(listCdcDocumentsServer.serverHandler('project_1')).resolves.toBe(documents);

		expect(mocks.requireActiveOrg).toHaveBeenCalledWith(new Headers());
		expect(mocks.listCdcDocumentsForOrg).toHaveBeenCalledWith('org_1', 'project_1');
	});

	it('maps a missing CDC document to 404', async () => {
		mocks.getCdcDocumentForOrg.mockResolvedValue(null);

		await expect(getCdcDocumentServer.serverHandler('cdc_missing')).rejects.toMatchObject({
			status: 404,
			message: 'CDC document not found'
		});

		expect(mocks.getCdcDocumentForOrg).toHaveBeenCalledWith('org_1', 'cdc_missing');
	});

	it('validates run CDC with the current user and refreshes related queries', async () => {
		mocks.validateRunCdcForOrg.mockResolvedValue({
			id: 'cdc_1',
			projectId: 'project_1',
			version: 3,
			markdown: '# CDC'
		});

		await expect(validateRunCdc({ runId: 'run_1' })).resolves.toEqual({
			id: 'cdc_1',
			projectId: 'project_1',
			version: 3
		});

		expect(mocks.validateRunCdcForOrg).toHaveBeenCalledWith('org_1', 'user_1', 'run_1');
		expect(getRun).toHaveBeenCalledWith('run_1');
		expect(mocks.getRunRefresh).toHaveBeenCalledOnce();
		expect(mocks.listCdcDocumentsRefresh).toHaveBeenCalledOnce();
		expect(listCdcDocuments).toHaveBeenCalledWith('project_1');
	});

	it('maps a null validation result to 404', async () => {
		mocks.validateRunCdcForOrg.mockResolvedValue(null);

		await expect(validateRunCdc({ runId: 'run_missing' })).rejects.toMatchObject({
			status: 404,
			message: 'Run not found'
		});

		expect(mocks.getRunRefresh).not.toHaveBeenCalled();
		expect(mocks.listCdcDocumentsRefresh).not.toHaveBeenCalled();
	});

	it('maps CDC service errors to bad requests', async () => {
		mocks.validateRunCdcForOrg.mockRejectedValue(
			new mocks.CdcDocumentServiceError('No complete CDC draft found in this run')
		);

		await expect(validateRunCdc({ runId: 'run_1' })).rejects.toMatchObject({
			status: 400,
			message: 'No complete CDC draft found in this run'
		});

		expect(mocks.getRunRefresh).not.toHaveBeenCalled();
		expect(mocks.listCdcDocumentsRefresh).not.toHaveBeenCalled();
	});
});
