import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
	const startResults: Promise<unknown>[] = [];
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
			start: vi.fn(() => startResults.shift() ?? Promise.resolve(undefined)),
			createQueue: vi.fn().mockResolvedValue(undefined),
			updateQueue: vi.fn().mockResolvedValue(undefined),
			send: vi.fn().mockResolvedValue('job1')
		};
		bossInstances.push(boss);
		return boss;
	});
	return { bossInstances, PgBoss, startResults };
});

vi.mock('pg-boss', () => ({
	PgBoss: mocks.PgBoss
}));

vi.mock('$env/dynamic/private', () => ({
	env: { DATABASE_URL: 'postgres://queue' }
}));

async function loadQueue() {
	return import('$lib/server/runtime/queue');
}

describe('queue', () => {
	beforeEach(() => {
		vi.resetModules();
		mocks.bossInstances.length = 0;
		mocks.startResults.length = 0;
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

	it('creates the project environment service provision queue without retries', async () => {
		const {
			ensureProjectEnvironmentServiceProvisionQueue,
			PROJECT_ENVIRONMENT_SERVICE_PROVISION_QUEUE
		} = await loadQueue();
		const boss = {
			createQueue: vi.fn().mockResolvedValue(undefined),
			updateQueue: vi.fn().mockResolvedValue(undefined)
		};

		await ensureProjectEnvironmentServiceProvisionQueue(boss as never);

		expect(boss.createQueue).toHaveBeenCalledWith(
			PROJECT_ENVIRONMENT_SERVICE_PROVISION_QUEUE,
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

	it('updates the project environment service provision queue retry limit when createQueue is idempotently ignored', async () => {
		const {
			ensureProjectEnvironmentServiceProvisionQueue,
			PROJECT_ENVIRONMENT_SERVICE_PROVISION_QUEUE
		} = await loadQueue();
		const boss = {
			createQueue: vi.fn().mockRejectedValue(new Error('queue exists')),
			updateQueue: vi.fn().mockResolvedValue(undefined)
		};

		await ensureProjectEnvironmentServiceProvisionQueue(boss as never);

		expect(boss.updateQueue).toHaveBeenCalledWith(
			PROJECT_ENVIRONMENT_SERVICE_PROVISION_QUEUE,
			expect.objectContaining({ retryLimit: 0 })
		);
	});

	it('enqueues project environment prepare jobs without retries', async () => {
		const { enqueueProjectEnvironmentPrepare, PROJECT_ENVIRONMENT_PREPARE_QUEUE } =
			await loadQueue();
		const input = { profileId: 'env1', requestedById: 'u1', force: false };

		await enqueueProjectEnvironmentPrepare(input);

		const boss = mocks.bossInstances[0];
		expect(boss.send).toHaveBeenCalledWith(
			PROJECT_ENVIRONMENT_PREPARE_QUEUE,
			input,
			expect.objectContaining({ retryLimit: 0 })
		);
	});

	it('enqueues project environment service provisioning jobs without retries', async () => {
		const {
			enqueueProjectEnvironmentServiceProvision,
			PROJECT_ENVIRONMENT_SERVICE_PROVISION_QUEUE
		} = await loadQueue();
		const input = { serviceId: 'svc1' };

		await enqueueProjectEnvironmentServiceProvision(input);

		const boss = mocks.bossInstances[0];
		expect(boss.send).toHaveBeenCalledWith(
			PROJECT_ENVIRONMENT_SERVICE_PROVISION_QUEUE,
			input,
			expect.objectContaining({ retryLimit: 0 })
		);
	});

	it('ensures all sender queues before enqueuing', async () => {
		const {
			enqueueRun,
			RUN_QUEUE,
			PROJECT_ENVIRONMENT_PREPARE_QUEUE,
			PROJECT_ENVIRONMENT_SERVICE_PROVISION_QUEUE
		} = await loadQueue();

		await enqueueRun('run1');

		const boss = mocks.bossInstances[0];
		expect(boss.createQueue).toHaveBeenCalledWith(RUN_QUEUE);
		expect(boss.createQueue).toHaveBeenCalledWith(
			PROJECT_ENVIRONMENT_PREPARE_QUEUE,
			expect.objectContaining({ retryLimit: 0 })
		);
		expect(boss.createQueue).toHaveBeenCalledWith(
			PROJECT_ENVIRONMENT_SERVICE_PROVISION_QUEUE,
			expect.objectContaining({ retryLimit: 0 })
		);
	});

	it('shares cold sender initialization across concurrent enqueues', async () => {
		const {
			enqueueRun,
			enqueueProjectEnvironmentServiceProvision,
			RUN_QUEUE,
			PROJECT_ENVIRONMENT_SERVICE_PROVISION_QUEUE
		} = await loadQueue();
		let resolveStart!: () => void;
		const startGate = new Promise<void>((resolve) => {
			resolveStart = resolve;
		});
		mocks.startResults.push(startGate);

		const runJob = enqueueRun('run1');
		const serviceJob = enqueueProjectEnvironmentServiceProvision({ serviceId: 'svc1' });
		await Promise.resolve();

		expect(mocks.bossInstances).toHaveLength(1);
		const firstBoss = mocks.bossInstances[0];
		expect(firstBoss.send).not.toHaveBeenCalled();

		resolveStart();
		await Promise.all([runJob, serviceJob]);

		expect(firstBoss.send).toHaveBeenCalledWith(RUN_QUEUE, { runId: 'run1' });
		expect(firstBoss.send).toHaveBeenCalledWith(
			PROJECT_ENVIRONMENT_SERVICE_PROVISION_QUEUE,
			{ serviceId: 'svc1' },
			expect.objectContaining({ retryLimit: 0 })
		);
	});
});
