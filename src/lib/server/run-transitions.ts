import type { RunStatus } from '@prisma/client';
import { assertTransition } from '$lib/domain/run-status';
import { prisma } from '$lib/server/prisma';

export async function transitionRun(
	runId: string,
	from: RunStatus | readonly RunStatus[],
	to: RunStatus,
	data: Record<string, unknown> = {}
): Promise<boolean> {
	const fromStatuses = Array.isArray(from) ? from : [from];
	for (const fromStatus of fromStatuses) {
		assertTransition(fromStatus, to);
	}

	const res = await prisma.run.updateMany({
		where: { id: runId, status: { in: [...fromStatuses] } },
		data: { ...data, status: to }
	});
	return res.count > 0;
}
