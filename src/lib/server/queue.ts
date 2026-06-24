import { PgBoss } from 'pg-boss';
import { env } from '$env/dynamic/private';

export const RUN_QUEUE = 'run-execute';
export const PROJECT_ENVIRONMENT_PREPARE_QUEUE = 'project-environment-prepare';
export const PROJECT_ENVIRONMENT_PREPARE_QUEUE_OPTIONS = { retryLimit: 0 } as const;

export function makeBoss(): PgBoss {
	const connectionString = env.DATABASE_URL!;
	if (!connectionString) throw new Error('DATABASE_URL is required for the job queue');
	return new PgBoss(connectionString);
}

export async function ensureQueue(
	boss: PgBoss,
	queueName: string,
	options?: Parameters<PgBoss['createQueue']>[1]
): Promise<void> {
	try {
		if (options) {
			await boss.createQueue(queueName, options);
		} else {
			await boss.createQueue(queueName);
		}
	} catch {
		// déjà créée — ignore
	}
}

/** Crée la file si absente. `createQueue` est prévue pour être appelée une fois ; on ignore les répétitions. */
export async function ensureRunQueue(boss: PgBoss): Promise<void> {
	await ensureQueue(boss, RUN_QUEUE);
}

export async function ensureProjectEnvironmentPrepareQueue(boss: PgBoss): Promise<void> {
	await ensureQueue(
		boss,
		PROJECT_ENVIRONMENT_PREPARE_QUEUE,
		PROJECT_ENVIRONMENT_PREPARE_QUEUE_OPTIONS
	);
	const updateQueue = (
		boss as unknown as {
			updateQueue?: (
				queueName: string,
				options: typeof PROJECT_ENVIRONMENT_PREPARE_QUEUE_OPTIONS
			) => Promise<void>;
		}
	).updateQueue;
	if (typeof updateQueue === 'function') {
		try {
			await updateQueue.call(
				boss,
				PROJECT_ENVIRONMENT_PREPARE_QUEUE,
				PROJECT_ENVIRONMENT_PREPARE_QUEUE_OPTIONS
			);
		} catch {
			// best-effort: old pg-boss versions or transient DB errors should not block startup
		}
	}
}

let sender: PgBoss | null = null;

async function ensureSender(): Promise<PgBoss> {
	if (!sender) {
		sender = makeBoss();
		await sender.start();
		await ensureRunQueue(sender);
		await ensureProjectEnvironmentPrepareQueue(sender);
	}
	return sender;
}

/** Enqueue un run depuis le contexte SvelteKit (sender singleton démarré paresseusement). */
export async function enqueueRun(runId: string): Promise<void> {
	const boss = await ensureSender();
	await boss.send(RUN_QUEUE, { runId });
}

export async function enqueueProjectEnvironmentPrepare(input: {
	profileId: string;
	requestedById: string;
	force: boolean;
}): Promise<void> {
	const boss = await ensureSender();
	await boss.send(
		PROJECT_ENVIRONMENT_PREPARE_QUEUE,
		input,
		PROJECT_ENVIRONMENT_PREPARE_QUEUE_OPTIONS
	);
}
