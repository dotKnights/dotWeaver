import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RUN_STATUS } from '$lib/domain/run-status';

const mocks = vi.hoisted(() => ({
	runUpdateMany: vi.fn()
}));

vi.mock('$lib/server/prisma', () => ({
	prisma: {
		run: {
			updateMany: mocks.runUpdateMany
		}
	}
}));

import { transitionRun } from './transitions';

describe('transitionRun', () => {
	beforeEach(() => vi.resetAllMocks());

	it('updates a run only when it is still in an allowed source status', async () => {
		mocks.runUpdateMany.mockResolvedValue({ count: 1 });

		await expect(
			transitionRun('r1', RUN_STATUS.RUNNING, RUN_STATUS.AWAITING_REVIEW, {
				headCommitSha: 'head'
			})
		).resolves.toBe(true);

		expect(mocks.runUpdateMany).toHaveBeenCalledWith({
			where: { id: 'r1', status: { in: [RUN_STATUS.RUNNING] } },
			data: { headCommitSha: 'head', status: RUN_STATUS.AWAITING_REVIEW }
		});
	});

	it('rejects invalid transitions before touching the database', async () => {
		await expect(transitionRun('r1', RUN_STATUS.QUEUED, RUN_STATUS.COMPLETED)).rejects.toThrow(
			/Invalid run transition/
		);

		expect(mocks.runUpdateMany).not.toHaveBeenCalled();
	});
});
