import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { RUN_STATUS } from '../../../../src/lib/domain/run-status';
import { RUN_MODE } from '../../../../src/lib/domain/run-mode';

vi.mock('$lib/server/prisma', () => ({
	prisma: {
		projectSkill: { findFirst: vi.fn() },
		cdcDocument: {
			findMany: vi.fn(),
			findFirst: vi.fn()
		},
		run: { findFirst: vi.fn() },
		$transaction: vi.fn()
	}
}));

const { prisma } = await import('../../../../src/lib/server/prisma');
const {
	CdcDocumentServiceError,
	assertCdcSkillEnabledForOrg,
	getCdcDocumentForOrg,
	listCdcDocumentsForOrg,
	validateRunCdcForOrg
} = await import('../../../../src/lib/server/cdc-documents-service');

const runFindFirst = prisma.run.findFirst as unknown as Mock;
const cdcFindFirst = prisma.cdcDocument.findFirst as unknown as Mock;
const transaction = prisma.$transaction as unknown as Mock;

function assistantEvent(seq: number, markdown: string) {
	return {
		seq,
		payload: {
			type: 'assistant',
			message: {
				content: [
					{
						type: 'text',
						text: `<!-- dotweaver:cdc:start -->\n${markdown}\n<!-- dotweaver:cdc:end -->`
					}
				]
			}
		}
	};
}

function expectRunLoadQuery(runId: string, organizationId: string) {
	expect(prisma.run.findFirst).toHaveBeenCalledWith({
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
}

describe('cdc-documents-service', () => {
	beforeEach(() => vi.clearAllMocks());

	it('checks for an enabled CDC skill in the project', async () => {
		vi.mocked(prisma.projectSkill.findFirst).mockResolvedValueOnce({ id: 'skill_1' } as never);

		await expect(assertCdcSkillEnabledForOrg('org_1', 'project_1')).resolves.toBeUndefined();
		expect(prisma.projectSkill.findFirst).toHaveBeenCalledWith({
			where: {
				organizationId: 'org_1',
				projectId: 'project_1',
				name: 'cahier-des-charges',
				enabled: true
			},
			select: { id: true }
		});
	});

	it('rejects CDC runs when the skill is missing', async () => {
		vi.mocked(prisma.projectSkill.findFirst).mockResolvedValueOnce(null as never);

		await expect(assertCdcSkillEnabledForOrg('org_1', 'project_1')).rejects.toThrow(
			CdcDocumentServiceError
		);
	});

	it('lists CDC documents for a project in version order', async () => {
		vi.mocked(prisma.cdcDocument.findMany).mockResolvedValueOnce([{ id: 'cdc_2' }] as never);

		await expect(listCdcDocumentsForOrg('org_1', 'project_1')).resolves.toEqual([
			{ id: 'cdc_2' }
		]);
		expect(prisma.cdcDocument.findMany).toHaveBeenCalledWith({
			where: { organizationId: 'org_1', projectId: 'project_1' },
			orderBy: { version: 'desc' },
			select: {
				id: true,
				title: true,
				version: true,
				runId: true,
				createdAt: true
			}
		});
	});

	it('gets a CDC document scoped to an organization with project and run context', async () => {
		cdcFindFirst.mockResolvedValueOnce({ id: 'cdc_1' });

		await expect(getCdcDocumentForOrg('org_1', 'cdc_1')).resolves.toEqual({ id: 'cdc_1' });
		expect(prisma.cdcDocument.findFirst).toHaveBeenCalledWith({
			where: { id: 'cdc_1', organizationId: 'org_1' },
			include: {
				project: { select: { id: true, owner: true, name: true } },
				run: { select: { id: true, status: true } }
			}
		});
	});

	it('creates version 1 from the latest marked CDC draft', async () => {
		const findUnique = vi.fn().mockResolvedValue(null);
		const aggregate = vi.fn().mockResolvedValue({ _max: { version: null } });
		const create = vi.fn().mockResolvedValue({
			id: 'cdc_1',
			projectId: 'project_1',
			runId: 'run_1',
			title: 'CRM interne',
			markdown: '# CRM interne\n\nBody',
			version: 1,
			sourceEventSeq: 5
		});
		runFindFirst.mockResolvedValueOnce({
			id: 'run_1',
			projectId: 'project_1',
			organizationId: 'org_1',
			mode: RUN_MODE.CDC,
			status: RUN_STATUS.AWAITING_REVIEW,
			events: [assistantEvent(5, '# CRM interne\n\nBody')]
		});
		transaction.mockImplementationOnce(async (fn) =>
			fn({
				cdcDocument: {
					findUnique,
					aggregate,
					create
				}
			})
		);

		const document = await validateRunCdcForOrg('org_1', 'user_1', 'run_1');

		expect(document).toMatchObject({
			id: 'cdc_1',
			version: 1,
			sourceEventSeq: 5,
			title: 'CRM interne'
		});
		expectRunLoadQuery('run_1', 'org_1');
		expect(aggregate).toHaveBeenCalledWith({
			where: { organizationId: 'org_1', projectId: 'project_1' },
			_max: { version: true }
		});
		expect(create).toHaveBeenCalledWith({
			data: {
				organizationId: 'org_1',
				projectId: 'project_1',
				runId: 'run_1',
				createdById: 'user_1',
				title: 'CRM interne',
				markdown: '# CRM interne\n\nBody',
				version: 1,
				sourceEventSeq: 5
			}
		});
	});

	it('returns an existing document when the same source event was already validated', async () => {
		runFindFirst.mockResolvedValueOnce({
			id: 'run_1',
			projectId: 'project_1',
			organizationId: 'org_1',
			mode: RUN_MODE.CDC,
			status: RUN_STATUS.AWAITING_REVIEW,
			events: [assistantEvent(7, '# Existing\n\nBody')]
		});
		transaction.mockImplementationOnce(async (fn) =>
			fn({
				cdcDocument: {
					findUnique: vi.fn().mockResolvedValue({
						id: 'cdc_existing',
						version: 2,
						sourceEventSeq: 7
					})
				}
			})
		);

		await expect(validateRunCdcForOrg('org_1', 'user_1', 'run_1')).resolves.toEqual({
			id: 'cdc_existing',
			version: 2,
			sourceEventSeq: 7
		});
	});

	it('returns the existing document when same source event creation races', async () => {
		const p2002 = { code: 'P2002', meta: { target: ['runId', 'sourceEventSeq'] } };
		runFindFirst.mockResolvedValueOnce({
			id: 'run_1',
			projectId: 'project_1',
			organizationId: 'org_1',
			mode: RUN_MODE.CDC,
			status: RUN_STATUS.AWAITING_REVIEW,
			events: [assistantEvent(7, '# Existing\n\nBody')]
		});
		transaction.mockRejectedValueOnce(p2002);
		cdcFindFirst.mockResolvedValueOnce({
			id: 'cdc_existing',
			version: 2,
			sourceEventSeq: 7
		});

		await expect(validateRunCdcForOrg('org_1', 'user_1', 'run_1')).resolves.toEqual({
			id: 'cdc_existing',
			version: 2,
			sourceEventSeq: 7
		});
		expect(prisma.cdcDocument.findFirst).toHaveBeenCalledWith({
			where: {
				organizationId: 'org_1',
				runId: 'run_1',
				sourceEventSeq: 7
			}
		});
	});

	it('retries version allocation when a project version create races', async () => {
		const p2002 = { code: 'P2002', meta: { target: ['projectId', 'version'] } };
		const firstCreate = vi.fn().mockRejectedValue(p2002);
		const secondCreate = vi.fn().mockResolvedValue({
			id: 'cdc_2',
			version: 3,
			sourceEventSeq: 9
		});
		runFindFirst.mockResolvedValueOnce({
			id: 'run_1',
			projectId: 'project_1',
			organizationId: 'org_1',
			mode: RUN_MODE.CDC,
			status: RUN_STATUS.AWAITING_REVIEW,
			events: [assistantEvent(9, '# Retry\n\nBody')]
		});
		transaction
			.mockImplementationOnce(async (fn) =>
				fn({
					cdcDocument: {
						findUnique: vi.fn().mockResolvedValue(null),
						aggregate: vi.fn().mockResolvedValue({ _max: { version: 1 } }),
						create: firstCreate
					}
				})
			)
			.mockImplementationOnce(async (fn) =>
				fn({
					cdcDocument: {
						findUnique: vi.fn().mockResolvedValue(null),
						aggregate: vi.fn().mockResolvedValue({ _max: { version: 2 } }),
						create: secondCreate
					}
				})
			);

		await expect(validateRunCdcForOrg('org_1', 'user_1', 'run_1')).resolves.toEqual({
			id: 'cdc_2',
			version: 3,
			sourceEventSeq: 9
		});
		expect(transaction).toHaveBeenCalledTimes(2);
		expect(firstCreate).toHaveBeenCalledWith({
			data: expect.objectContaining({ version: 2 })
		});
		expect(secondCreate).toHaveBeenCalledWith({
			data: expect.objectContaining({ version: 3 })
		});
	});

	it('returns null when the run is missing', async () => {
		runFindFirst.mockResolvedValueOnce(null);

		await expect(validateRunCdcForOrg('org_1', 'user_1', 'run_missing')).resolves.toBeNull();
		expectRunLoadQuery('run_missing', 'org_1');
		expect(transaction).not.toHaveBeenCalled();
	});

	it('rejects awaiting review CDC runs without a complete CDC draft', async () => {
		runFindFirst.mockResolvedValueOnce({
			id: 'run_1',
			projectId: 'project_1',
			organizationId: 'org_1',
			mode: RUN_MODE.CDC,
			status: RUN_STATUS.AWAITING_REVIEW,
			events: [
				{
					seq: 3,
					payload: {
						type: 'assistant',
						message: {
							content: [{ type: 'text', text: 'Draft without CDC markers' }]
						}
					}
				}
			]
		});

		const validation = validateRunCdcForOrg('org_1', 'user_1', 'run_1');

		await expect(validation).rejects.toThrow(CdcDocumentServiceError);
		await expect(validation).rejects.toThrow('No complete CDC draft found in this run');
		expect(transaction).not.toHaveBeenCalled();
	});

	it('rejects non CDC runs and non review runs', async () => {
		runFindFirst.mockResolvedValueOnce({
			id: 'run_1',
			mode: RUN_MODE.AGENT,
			status: RUN_STATUS.AWAITING_REVIEW,
			events: []
		});
		await expect(validateRunCdcForOrg('org_1', 'user_1', 'run_1')).rejects.toThrow(
			'Run is not a CDC run'
		);

		runFindFirst.mockResolvedValueOnce({
			id: 'run_2',
			mode: RUN_MODE.CDC,
			status: RUN_STATUS.RUNNING,
			events: []
		});
		await expect(validateRunCdcForOrg('org_1', 'user_1', 'run_2')).rejects.toThrow(
			'Run is not awaiting review'
		);
	});
});
