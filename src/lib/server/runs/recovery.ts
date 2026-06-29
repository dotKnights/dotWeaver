import type { RunStatus } from '@prisma/client';
import { RUN_STATUS, RUN_STATUS_GROUPS } from '$lib/domain/run-status';
import { prisma } from '$lib/server/prisma';

/** Statuts actifs sans worker vivant au démarrage → orphelins. `queued` est re-livré par pg-boss. */
export const ORPHAN_STATUSES: readonly RunStatus[] = RUN_STATUS_GROUPS.ORPHANABLE;

/** Marque `failed` les runs orphelins (worker redémarré en plein run). Renvoie le nombre récupéré. */
export async function recoverOrphanedRuns(): Promise<number> {
	const res = await prisma.run.updateMany({
		where: { status: { in: [...ORPHAN_STATUSES] } },
		data: {
			status: RUN_STATUS.FAILED,
			error: 'Interrupted by a worker restart',
			finishedAt: new Date()
		}
	});
	return res.count;
}
