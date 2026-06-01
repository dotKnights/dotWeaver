import { makeBoss, RUN_QUEUE, ensureRunQueue } from '$lib/server/queue';
import { executeRun } from '$lib/server/run-orchestrator';
import { installProcessSafetyNet } from '$lib/server/process-safety';
import { recoverOrphanedRuns } from '$lib/server/run-recovery';

async function main() {
	installProcessSafetyNet('runner');
	const boss = makeBoss();
	boss.on('error', (e) => console.error('[runner] boss error', e));
	await boss.start();
	await ensureRunQueue(boss);

	const recovered = await recoverOrphanedRuns();
	if (recovered > 0) console.log(`[runner] recovered ${recovered} orphaned run(s) → failed`);

	await boss.work(RUN_QUEUE, { batchSize: 1 }, async ([job]) => {
		const { runId } = job.data as { runId: string };
		console.log('[runner] executing run', runId);
		await executeRun(runId);
		console.log('[runner] finished run', runId);
	});

	console.log('[runner] worker started, listening on', RUN_QUEUE);
}

main().catch((e) => {
	console.error('[runner] fatal', e);
	process.exit(1);
});
