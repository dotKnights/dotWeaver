import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { RUN_STATUS } from '../../../../src/lib/domain/run-status';
import { RUN_MODE } from '../../../../src/lib/domain/run-mode';

vi.mock('$lib/server/prisma', () => ({
	prisma: {
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

function expectTransactionRunLoadQuery(findFirst: Mock, runId: string, organizationId: string) {
	expect(findFirst).toHaveBeenCalledWith({
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

function currentRun(
	overrides: Partial<{
		mode: string;
		status: string;
		events: ReturnType<typeof assistantEvent>[];
	}> = {}
) {
	return {
		id: 'run_1',
		projectId: 'project_1',
		organizationId: 'org_1',
		mode: overrides.mode ?? RUN_MODE.CDC,
		status: overrides.status ?? RUN_STATUS.AWAITING_REVIEW,
		events: overrides.events ?? []
	};
}

describe('cdc-documents-service', () => {
	beforeEach(() => vi.clearAllMocks());

	it('lists CDC documents for a project in version order', async () => {
		vi.mocked(prisma.cdcDocument.findMany).mockResolvedValueOnce([{ id: 'cdc_2' }] as never);

		await expect(listCdcDocumentsForOrg('org_1', 'project_1')).resolves.toEqual([{ id: 'cdc_2' }]);
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
		const txRunFindFirst = vi.fn().mockResolvedValue(
			currentRun({
				events: [assistantEvent(5, '# CRM interne\n\nBody')]
			})
		);
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
				run: {
					findFirst: txRunFindFirst
				},
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
		expectTransactionRunLoadQuery(txRunFindFirst, 'run_1', 'org_1');
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
				run: {
					findFirst: vi.fn().mockResolvedValue(
						currentRun({
							events: [assistantEvent(7, '# Existing\n\nBody')]
						})
					)
				},
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
					run: {
						findFirst: vi.fn().mockResolvedValue(
							currentRun({
								events: [assistantEvent(9, '# Retry\n\nBody')]
							})
						)
					},
					cdcDocument: {
						findUnique: vi.fn().mockResolvedValue(null),
						aggregate: vi.fn().mockResolvedValue({ _max: { version: 1 } }),
						create: firstCreate
					}
				})
			)
			.mockImplementationOnce(async (fn) =>
				fn({
					run: {
						findFirst: vi.fn().mockResolvedValue(
							currentRun({
								events: [assistantEvent(9, '# Retry\n\nBody')]
							})
						)
					},
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

	it('creates from the latest draft loaded inside the transaction', async () => {
		const create = vi.fn().mockResolvedValue({
			id: 'cdc_new',
			version: 4,
			sourceEventSeq: 11,
			title: 'New draft'
		});
		runFindFirst.mockResolvedValueOnce({
			id: 'run_1',
			projectId: 'project_1',
			organizationId: 'org_1',
			mode: RUN_MODE.CDC,
			status: RUN_STATUS.AWAITING_REVIEW,
			events: [assistantEvent(5, '# Old draft\n\nBody')]
		});
		transaction.mockImplementationOnce(async (fn) =>
			fn({
				run: {
					findFirst: vi.fn().mockResolvedValue(
						currentRun({
							events: [
								assistantEvent(5, '# Old draft\n\nBody'),
								assistantEvent(11, '# New draft\n\nFresh body')
							]
						})
					)
				},
				cdcDocument: {
					findUnique: vi.fn().mockResolvedValue(null),
					aggregate: vi.fn().mockResolvedValue({ _max: { version: 3 } }),
					create
				}
			})
		);

		await expect(validateRunCdcForOrg('org_1', 'user_1', 'run_1')).resolves.toMatchObject({
			id: 'cdc_new',
			sourceEventSeq: 11,
			title: 'New draft'
		});
		expect(create).toHaveBeenCalledWith({
			data: {
				organizationId: 'org_1',
				projectId: 'project_1',
				runId: 'run_1',
				createdById: 'user_1',
				title: 'New draft',
				markdown: '# New draft\n\nFresh body',
				version: 4,
				sourceEventSeq: 11
			}
		});
	});

	it('does not handle P2002 targets with extra fields as known CDC unique conflicts', async () => {
		const p2002 = {
			code: 'P2002',
			meta: { target: ['projectId', 'version', 'organizationId'] }
		};
		runFindFirst.mockResolvedValueOnce({
			id: 'run_1',
			projectId: 'project_1',
			organizationId: 'org_1',
			mode: RUN_MODE.CDC,
			status: RUN_STATUS.AWAITING_REVIEW,
			events: [assistantEvent(9, '# Exact\n\nBody')]
		});
		transaction.mockImplementationOnce(async (fn) =>
			fn({
				run: {
					findFirst: vi.fn().mockResolvedValue(
						currentRun({
							events: [assistantEvent(9, '# Exact\n\nBody')]
						})
					)
				},
				cdcDocument: {
					findUnique: vi.fn().mockResolvedValue(null),
					aggregate: vi.fn().mockResolvedValue({ _max: { version: 2 } }),
					create: vi.fn().mockRejectedValue(p2002)
				}
			})
		);

		await expect(validateRunCdcForOrg('org_1', 'user_1', 'run_1')).rejects.toBe(p2002);
		expect(transaction).toHaveBeenCalledTimes(1);
	});

	it('rechecks run state inside the transaction before creating', async () => {
		const create = vi.fn();
		runFindFirst.mockResolvedValueOnce({
			id: 'run_1',
			projectId: 'project_1',
			organizationId: 'org_1',
			mode: RUN_MODE.CDC,
			status: RUN_STATUS.AWAITING_REVIEW,
			events: [assistantEvent(9, '# Stale\n\nBody')]
		});
		transaction.mockImplementationOnce(async (fn) =>
			fn({
				run: { findFirst: vi.fn().mockResolvedValue(currentRun({ status: RUN_STATUS.RUNNING })) },
				cdcDocument: {
					findUnique: vi.fn().mockResolvedValue(null),
					aggregate: vi.fn().mockResolvedValue({ _max: { version: 1 } }),
					create: create.mockResolvedValue({ id: 'cdc_stale' })
				}
			})
		);

		const validation = validateRunCdcForOrg('org_1', 'user_1', 'run_1');

		await expect(validation).rejects.toThrow(CdcDocumentServiceError);
		await expect(validation).rejects.toThrow('Run is not awaiting review');
		expect(create).not.toHaveBeenCalled();
	});

	it('throws after repeated project version allocation conflicts', async () => {
		const p2002 = { code: 'P2002', meta: { target: ['projectId', 'version'] } };
		runFindFirst.mockResolvedValueOnce({
			id: 'run_1',
			projectId: 'project_1',
			organizationId: 'org_1',
			mode: RUN_MODE.CDC,
			status: RUN_STATUS.AWAITING_REVIEW,
			events: [assistantEvent(9, '# Exhaustion\n\nBody')]
		});
		transaction.mockImplementation(async (fn) =>
			fn({
				run: {
					findFirst: vi.fn().mockResolvedValue(
						currentRun({
							events: [assistantEvent(9, '# Exhaustion\n\nBody')]
						})
					)
				},
				cdcDocument: {
					findUnique: vi.fn().mockResolvedValue(null),
					aggregate: vi.fn().mockResolvedValue({ _max: { version: 2 } }),
					create: vi.fn().mockRejectedValue(p2002)
				}
			})
		);

		const validation = validateRunCdcForOrg('org_1', 'user_1', 'run_1');

		await expect(validation).rejects.toThrow(CdcDocumentServiceError);
		await expect(validation).rejects.toThrow(
			'Could not allocate CDC document version after repeated conflicts'
		);
		expect(transaction).toHaveBeenCalledTimes(3);
	});

	it('returns null when the run is missing', async () => {
		runFindFirst.mockResolvedValueOnce(null);

		await expect(validateRunCdcForOrg('org_1', 'user_1', 'run_missing')).resolves.toBeNull();
		expectRunLoadQuery('run_missing', 'org_1');
		expect(transaction).not.toHaveBeenCalled();
	});

	it('wraps invalid marked CDC markdown from the initial run load', async () => {
		runFindFirst.mockResolvedValueOnce({
			id: 'run_1',
			projectId: 'project_1',
			organizationId: 'org_1',
			mode: RUN_MODE.CDC,
			status: RUN_STATUS.AWAITING_REVIEW,
			events: [assistantEvent(4, '   ')]
		});

		const validation = validateRunCdcForOrg('org_1', 'user_1', 'run_1');

		await expect(validation).rejects.toThrow(CdcDocumentServiceError);
		await expect(validation).rejects.toThrow('CDC markdown is empty');
		expect(transaction).not.toHaveBeenCalled();
	});

	it('wraps invalid marked CDC markdown from the transaction run load', async () => {
		const findUnique = vi.fn();
		runFindFirst.mockResolvedValueOnce({
			id: 'run_1',
			projectId: 'project_1',
			organizationId: 'org_1',
			mode: RUN_MODE.CDC,
			status: RUN_STATUS.AWAITING_REVIEW,
			events: [assistantEvent(4, '# Valid\n\nBody')]
		});
		transaction.mockImplementationOnce(async (fn) =>
			fn({
				run: {
					findFirst: vi.fn().mockResolvedValue(
						currentRun({
							events: [assistantEvent(5, '   ')]
						})
					)
				},
				cdcDocument: {
					findUnique,
					aggregate: vi.fn(),
					create: vi.fn()
				}
			})
		);

		const validation = validateRunCdcForOrg('org_1', 'user_1', 'run_1');

		await expect(validation).rejects.toThrow(CdcDocumentServiceError);
		await expect(validation).rejects.toThrow('CDC markdown is empty');
		expect(findUnique).not.toHaveBeenCalled();
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
