import { PgBoss } from 'pg-boss';
import { env } from '$env/dynamic/private';

export const RUN_QUEUE = 'run-execute';
export const PROJECT_ENVIRONMENT_PREPARE_QUEUE = 'project-environment-prepare';
export const PROJECT_ENVIRONMENT_PREPARE_QUEUE_OPTIONS = { retryLimit: 0 } as const;
export const PROJECT_ENVIRONMENT_SERVICE_PROVISION_QUEUE = 'project-environment-service-provision';
export const PROJECT_ENVIRONMENT_SERVICE_PROVISION_QUEUE_OPTIONS = { retryLimit: 0 } as const;

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

async function ensureQueueWithOptions(
	boss: PgBoss,
	queueName: string,
	options: Parameters<PgBoss['createQueue']>[1]
): Promise<void> {
	await ensureQueue(boss, queueName, options);
	const updateQueue = (
		boss as unknown as {
			updateQueue?: (
				queueName: string,
				options: Parameters<PgBoss['createQueue']>[1]
			) => Promise<void>;
		}
	).updateQueue;
	if (typeof updateQueue === 'function') {
		try {
			await updateQueue.call(boss, queueName, options);
		} catch {
			// best-effort: old pg-boss versions or transient DB errors should not block startup
		}
	}
}

export async function ensureProjectEnvironmentPrepareQueue(boss: PgBoss): Promise<void> {
	await ensureQueueWithOptions(
		boss,
		PROJECT_ENVIRONMENT_PREPARE_QUEUE,
		PROJECT_ENVIRONMENT_PREPARE_QUEUE_OPTIONS
	);
}

export async function ensureProjectEnvironmentServiceProvisionQueue(boss: PgBoss): Promise<void> {
	await ensureQueueWithOptions(
		boss,
		PROJECT_ENVIRONMENT_SERVICE_PROVISION_QUEUE,
		PROJECT_ENVIRONMENT_SERVICE_PROVISION_QUEUE_OPTIONS
	);
}

let sender: PgBoss | null = null;
let senderPromise: Promise<PgBoss> | null = null;

async function createSender(): Promise<PgBoss> {
	const boss = makeBoss();
	await boss.start();
	await ensureRunQueue(boss);
	await ensureProjectEnvironmentPrepareQueue(boss);
	await ensureProjectEnvironmentServiceProvisionQueue(boss);
	sender = boss;
	return boss;
}

async function ensureSender(): Promise<PgBoss> {
	if (sender) return sender;
	senderPromise ??= createSender().finally(() => {
		senderPromise = null;
	});
	return senderPromise;
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

export async function enqueueProjectEnvironmentServiceProvision(input: {
	serviceId: string;
}): Promise<void> {
	const boss = await ensureSender();
	await boss.send(
		PROJECT_ENVIRONMENT_SERVICE_PROVISION_QUEUE,
		input,
		PROJECT_ENVIRONMENT_SERVICE_PROVISION_QUEUE_OPTIONS
	);
}
