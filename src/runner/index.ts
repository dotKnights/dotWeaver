import './instrument';
import * as Sentry from '@sentry/node';
import { makeBoss, RUN_QUEUE, ensureRunQueue } from '$lib/server/queue';
import { executeRun } from '$lib/server/run-orchestrator';
import { installProcessSafetyNet } from '$lib/server/process-safety';
import { recoverOrphanedRuns } from '$lib/server/run-recovery';

async function main() {
	installProcessSafetyNet('runner');
	const boss = makeBoss();
	boss.on('error', (e) => {
		console.error('[runner] boss error', e);
		Sentry.captureException(e);
	});
	await boss.start();
	await ensureRunQueue(boss);

	const recovered = await recoverOrphanedRuns();
	if (recovered > 0) console.log(`[runner] recovered ${recovered} orphaned run(s) → failed`);

	await boss.work(RUN_QUEUE, { batchSize: 1 }, async ([job]) => {
		const { runId } = job.data as { runId: string };
		console.log('[runner] executing run', runId);
		try {
			await executeRun(runId);
		} catch (e) {
			Sentry.captureException(e, { tags: { runId } });
			throw e;
		}
		console.log('[runner] finished run', runId);
	});

	console.log('[runner] worker started, listening on', RUN_QUEUE);
}

main().catch(async (e) => {
	console.error('[runner] fatal', e);
	Sentry.captureException(e);
	await Sentry.flush(2000);
	process.exit(1);
});
