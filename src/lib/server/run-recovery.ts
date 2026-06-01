import type { RunStatus } from '@prisma/client';
import { prisma } from '$lib/server/prisma';

/** Statuts actifs sans worker vivant au démarrage → orphelins. `queued` est re-livré par pg-boss. */
export const ORPHAN_STATUSES: RunStatus[] = ['preparing', 'running', 'pushing'];

/** Marque `failed` les runs orphelins (worker redémarré en plein run). Renvoie le nombre récupéré. */
export async function recoverOrphanedRuns(): Promise<number> {
	const res = await prisma.run.updateMany({
		where: { status: { in: ORPHAN_STATUSES } },
		data: { status: 'failed', error: 'Interrupted by a worker restart', finishedAt: new Date() }
	});
	return res.count;
}
