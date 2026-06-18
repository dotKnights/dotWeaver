import { command, getRequestEvent, query } from '$app/server';
import { error } from '@sveltejs/kit';
import z from 'zod';
import { cdcDocumentIdSchema, validateRunCdcSchema } from '$lib/schemas/cdc-documents';
import {
	CdcDocumentServiceError,
	getCdcDocumentForOrg,
	listCdcDocumentsForOrg,
	validateRunCdcForOrg
} from '$lib/server/cdc-documents-service';
import { requireActiveOrg } from '$lib/server/org';
import { requireHeaders } from '$lib/server/utils';
import { getRun } from '$lib/rfc/runs.remote';

async function requireOrganizationId(): Promise<string> {
	return await requireActiveOrg(requireHeaders());
}

function mapCdcError(e: unknown): never {
	if (e instanceof CdcDocumentServiceError) error(400, e.message);
	throw e;
}

export const listCdcDocuments = query(z.string().min(1), async (projectId) => {
	const organizationId = await requireOrganizationId();
	return await listCdcDocumentsForOrg(organizationId, projectId);
});

export const getCdcDocument = query(cdcDocumentIdSchema, async (id) => {
	const organizationId = await requireOrganizationId();
	const document = await getCdcDocumentForOrg(organizationId, id);
	if (!document) error(404, 'CDC document not found');
	return document;
});

export const validateRunCdc = command(validateRunCdcSchema, async ({ runId }) => {
	const organizationId = await requireOrganizationId();
	const { locals } = getRequestEvent();
	const userId = locals.user?.id;
	if (!userId) error(401, 'Not authenticated');

	try {
		const document = await validateRunCdcForOrg(organizationId, userId, runId);
		if (!document) error(404, 'Run not found');

		await getRun(runId).refresh();
		await listCdcDocuments(document.projectId).refresh();
		return {
			id: document.id,
			projectId: document.projectId,
			version: document.version
		};
	} catch (e) {
		mapCdcError(e);
	}
});
