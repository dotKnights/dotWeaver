import { Prisma } from '@prisma/client';
import { RUN_STATUS } from '$lib/domain/run-status';
import {
	CdcDocumentError,
	extractLatestCdcDraft,
	type CdcDraftEvent
} from '$lib/domain/cdc-document';
import { RUN_MODE } from '$lib/domain/run-mode';
import { prisma } from '$lib/server/prisma';

const MAX_VERSION_ALLOCATION_ATTEMPTS = 3;

export class CdcDocumentServiceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CdcDocumentServiceError';
	}
}

export function listCdcDocumentsForOrg(organizationId: string, projectId: string) {
	return prisma.cdcDocument.findMany({
		where: { organizationId, projectId },
		orderBy: { version: 'desc' },
		select: {
			id: true,
			title: true,
			version: true,
			runId: true,
			createdAt: true
		}
	});
}

export function getCdcDocumentForOrg(organizationId: string, id: string) {
	return prisma.cdcDocument.findFirst({
		where: { id, organizationId },
		include: {
			project: { select: { id: true, owner: true, name: true } },
			run: { select: { id: true, status: true } }
		}
	});
}

function isPrismaUniqueConstraintError(error: unknown): boolean {
	if (error instanceof Prisma.PrismaClientKnownRequestError) {
		return error.code === 'P2002';
	}
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		(error as { code?: unknown }).code === 'P2002'
	);
}

function hasUniqueConstraintTarget(error: unknown, targetNames: string[]): boolean {
	if (!isPrismaUniqueConstraintError(error)) return false;
	if (typeof error !== 'object' || error === null || !('meta' in error)) return false;

	const target = (error as { meta?: { target?: unknown } }).meta?.target;
	if (!Array.isArray(target)) return false;
	if (target.length !== targetNames.length) return false;

	return targetNames.every((targetName) => target.includes(targetName));
}

function assertRunCanCreateCdcDocument(run: { mode: string; status: string }): void {
	if (run.mode !== RUN_MODE.CDC) {
		throw new CdcDocumentServiceError('Run is not a CDC run');
	}
	if (run.status !== RUN_STATUS.AWAITING_REVIEW) {
		throw new CdcDocumentServiceError(`Run is not awaiting review (status: ${run.status})`);
	}
}

function extractLatestCdcDraftForService(events: CdcDraftEvent[]) {
	try {
		return extractLatestCdcDraft(events);
	} catch (error) {
		if (error instanceof CdcDocumentError) {
			throw new CdcDocumentServiceError(error.message);
		}
		throw error;
	}
}

export async function validateRunCdcForOrg(
	organizationId: string,
	createdById: string,
	runId: string
) {
	const run = await prisma.run.findFirst({
		where: { id: runId, organizationId },
		select: {
			id: true,
			projectId: true,
			organizationId: true,
			mode: true,
			status: true,
			events: {
				orderBy: { seq: 'asc' },
				select: { seq: true, payload: true }
			}
		}
	});
	if (!run) return null;
	assertRunCanCreateCdcDocument(run);

	const initialDraft = extractLatestCdcDraftForService(run.events);
	if (!initialDraft) {
		throw new CdcDocumentServiceError('No complete CDC draft found in this run');
	}

	let attemptedDraft = initialDraft;
	for (let attempt = 1; attempt <= MAX_VERSION_ALLOCATION_ATTEMPTS; attempt += 1) {
		try {
			return await prisma.$transaction(async (tx) => {
				const currentRun = await tx.run.findFirst({
					where: { id: runId, organizationId },
					select: {
						id: true,
						projectId: true,
						organizationId: true,
						mode: true,
						status: true,
						events: {
							orderBy: { seq: 'asc' },
							select: { seq: true, payload: true }
						}
					}
				});
				if (!currentRun) {
					throw new CdcDocumentServiceError('Run is no longer available for CDC validation');
				}
				assertRunCanCreateCdcDocument(currentRun);

				const draft = extractLatestCdcDraftForService(currentRun.events);
				if (!draft) {
					throw new CdcDocumentServiceError('No complete CDC draft found in this run');
				}
				attemptedDraft = draft;

				const existing = await tx.cdcDocument.findUnique({
					where: {
						runId_sourceEventSeq: {
							runId,
							sourceEventSeq: draft.sourceEventSeq
						}
					}
				});
				if (existing) return existing;

				const aggregate = await tx.cdcDocument.aggregate({
					where: { organizationId, projectId: currentRun.projectId },
					_max: { version: true }
				});
				const version = (aggregate._max.version ?? 0) + 1;

				return tx.cdcDocument.create({
					data: {
						organizationId,
						projectId: currentRun.projectId,
						runId,
						createdById,
						title: draft.title,
						markdown: draft.markdown,
						version,
						sourceEventSeq: draft.sourceEventSeq
					}
				});
			});
		} catch (error) {
			if (hasUniqueConstraintTarget(error, ['runId', 'sourceEventSeq'])) {
				const existing = await prisma.cdcDocument.findFirst({
					where: {
						organizationId,
						runId,
						sourceEventSeq: attemptedDraft.sourceEventSeq
					}
				});
				if (existing) return existing;
			}

			if (hasUniqueConstraintTarget(error, ['projectId', 'version'])) {
				if (attempt < MAX_VERSION_ALLOCATION_ATTEMPTS) continue;
				throw new CdcDocumentServiceError(
					'Could not allocate CDC document version after repeated conflicts'
				);
			}

			throw error;
		}
	}

	throw new CdcDocumentServiceError('Could not allocate CDC document version');
}
