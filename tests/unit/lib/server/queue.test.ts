import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
	const bossInstances: Array<{
		connectionString: string;
		start: ReturnType<typeof vi.fn>;
		createQueue: ReturnType<typeof vi.fn>;
		updateQueue: ReturnType<typeof vi.fn>;
		send: ReturnType<typeof vi.fn>;
	}> = [];
	const PgBoss = vi.fn(function PgBossMock(connectionString: string) {
		const boss = {
			connectionString,
			start: vi.fn().mockResolvedValue(undefined),
			createQueue: vi.fn().mockResolvedValue(undefined),
			updateQueue: vi.fn().mockResolvedValue(undefined),
			send: vi.fn().mockResolvedValue('job1')
		};
		bossInstances.push(boss);
		return boss;
	});
	return { bossInstances, PgBoss };
});

vi.mock('pg-boss', () => ({
	PgBoss: mocks.PgBoss
}));

vi.mock('$env/dynamic/private', () => ({
	env: { DATABASE_URL: 'postgres://queue' }
}));

async function loadQueue() {
	return import('$lib/server/queue');
}

describe('queue', () => {
	beforeEach(() => {
		vi.resetModules();
		mocks.bossInstances.length = 0;
		mocks.PgBoss.mockClear();
	});

	it('creates the project environment prepare queue without retries', async () => {
		const { ensureProjectEnvironmentPrepareQueue, PROJECT_ENVIRONMENT_PREPARE_QUEUE } =
			await loadQueue();
		const boss = {
			createQueue: vi.fn().mockResolvedValue(undefined),
			updateQueue: vi.fn().mockResolvedValue(undefined)
		};

		await ensureProjectEnvironmentPrepareQueue(boss as never);

		expect(boss.createQueue).toHaveBeenCalledWith(
			PROJECT_ENVIRONMENT_PREPARE_QUEUE,
			expect.objectContaining({ retryLimit: 0 })
		);
	});

	it('updates the project environment prepare queue retry limit when createQueue is idempotently ignored', async () => {
		const { ensureProjectEnvironmentPrepareQueue, PROJECT_ENVIRONMENT_PREPARE_QUEUE } =
			await loadQueue();
		const boss = {
			createQueue: vi.fn().mockRejectedValue(new Error('queue exists')),
			updateQueue: vi.fn().mockResolvedValue(undefined)
		};

		await ensureProjectEnvironmentPrepareQueue(boss as never);

		expect(boss.updateQueue).toHaveBeenCalledWith(
			PROJECT_ENVIRONMENT_PREPARE_QUEUE,
			expect.objectContaining({ retryLimit: 0 })
		);
	});

	it('enqueues project environment prepare jobs without retries', async () => {
		const { enqueueProjectEnvironmentPrepare, PROJECT_ENVIRONMENT_PREPARE_QUEUE } = await loadQueue();
		const input = { profileId: 'env1', requestedById: 'u1', force: false };

		await enqueueProjectEnvironmentPrepare(input);

		const boss = mocks.bossInstances[0];
		expect(boss.send).toHaveBeenCalledWith(
			PROJECT_ENVIRONMENT_PREPARE_QUEUE,
			input,
			expect.objectContaining({ retryLimit: 0 })
		);
	});
});
