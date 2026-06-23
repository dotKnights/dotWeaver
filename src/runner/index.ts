import {
	makeBoss,
	RUN_QUEUE,
	PROJECT_ENVIRONMENT_PREPARE_QUEUE,
	ensureRunQueue,
	ensureProjectEnvironmentPrepareQueue
} from '$lib/server/queue';
import { executeRun } from '$lib/server/run-orchestrator';
import {
	executeProjectEnvironmentPrepare,
	recoverOrphanedProjectEnvironmentPrepares
} from '$lib/server/project-environments/prepare';
import { installProcessSafetyNet } from '$lib/server/process-safety';
import { recoverOrphanedRuns } from '$lib/server/run-recovery';
import { ensureImage } from '$lib/server/docker';

const RUNNER_IMAGE = process.env.RUNNER_IMAGE ?? 'dotweaver-runner';

async function main() {
	installProcessSafetyNet('runner');

	// Build l'image agent si elle manque (machine neuve / après colima delete).
	await ensureImage(RUNNER_IMAGE);

	const boss = makeBoss();
	boss.on('error', (e) => console.error('[runner] boss error', e));
	await boss.start();
	await ensureRunQueue(boss);
	await ensureProjectEnvironmentPrepareQueue(boss);

	const recovered = await recoverOrphanedRuns();
	if (recovered > 0) console.log(`[runner] recovered ${recovered} orphaned run(s) → failed`);
	const recoveredPrepares = await recoverOrphanedProjectEnvironmentPrepares();
	if (recoveredPrepares > 0) {
		console.log(`[runner] recovered ${recoveredPrepares} orphaned prepare(s) → failed`);
	}

	await boss.work(RUN_QUEUE, { batchSize: 1 }, async ([job]) => {
		const { runId } = job.data as { runId: string };
		console.log('[runner] executing run', runId);
		await executeRun(runId);
		console.log('[runner] finished run', runId);
	});

	await boss.work(PROJECT_ENVIRONMENT_PREPARE_QUEUE, { batchSize: 1 }, async ([job]) => {
		const input = job.data as { profileId: string; requestedById: string; force: boolean };
		console.log('[runner] preparing project environment', input.profileId);
		try {
			await executeProjectEnvironmentPrepare(input);
			console.log('[runner] finished project environment prepare', input.profileId);
		} catch (error) {
			console.error('[runner] project environment prepare failed', input.profileId, error);
			throw error;
		}
	});

	console.log(
		'[runner] worker started, listening on',
		RUN_QUEUE,
		'and',
		PROJECT_ENVIRONMENT_PREPARE_QUEUE
	);
}

main().catch((e) => {
	console.error('[runner] fatal', e);
	process.exit(1);
});
