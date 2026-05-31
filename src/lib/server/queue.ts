import { PgBoss } from 'pg-boss';

export const RUN_QUEUE = 'run-execute';

export function makeBoss(): PgBoss {
	const connectionString = process.env.DATABASE_URL;
	if (!connectionString) throw new Error('DATABASE_URL is required for the job queue');
	return new PgBoss(connectionString);
}

/** Crée la file si absente. `createQueue` est prévue pour être appelée une fois ; on ignore les répétitions. */
export async function ensureRunQueue(boss: PgBoss): Promise<void> {
	try {
		await boss.createQueue(RUN_QUEUE);
	} catch {
		// déjà créée — ignore
	}
}

let sender: PgBoss | null = null;

/** Enqueue un run depuis le contexte SvelteKit (sender singleton démarré paresseusement). */
export async function enqueueRun(runId: string): Promise<void> {
	if (!sender) {
		sender = makeBoss();
		await sender.start();
		await ensureRunQueue(sender);
	}
	await sender.send(RUN_QUEUE, { runId });
}
