import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	error: vi.fn((status: number, message: string) => {
		throw Object.assign(new Error(message), { status });
	}),
	requireActor: vi.fn(),
	requireRunPermission: vi.fn(),
	requireProjectPermission: vi.fn(),
	runFindFirst: vi.fn(),
	profileFindFirst: vi.fn(),
	requireProjectEnvironmentServiceForOrg: vi.fn(),
	parseLastEventIdCursor: vi.fn(),
	formatSseEvent: vi.fn(),
	formatPrepareSseEvent: vi.fn(),
	formatServiceSseEvent: vi.fn(),
	streamRunEvents: vi.fn(),
	streamProjectEnvironmentPrepare: vi.fn(),
	streamProjectEnvironmentServiceEvents: vi.fn()
}));

vi.mock('@sveltejs/kit', () => ({ error: mocks.error }));
vi.mock('$lib/server/authz/actor', () => ({ requireActor: mocks.requireActor }));
vi.mock('$lib/server/authz/runs', () => ({
	requireRunPermission: mocks.requireRunPermission
}));
vi.mock('$lib/server/authz/service', () => ({
	requireProjectPermission: mocks.requireProjectPermission
}));
vi.mock('$lib/server/prisma', () => ({
	prisma: {
		run: { findFirst: mocks.runFindFirst },
		projectEnvironmentProfile: { findFirst: mocks.profileFindFirst }
	}
}));
vi.mock('$lib/server/runs/stream', () => ({
	parseLastEventIdCursor: mocks.parseLastEventIdCursor,
	formatSseEvent: mocks.formatSseEvent,
	streamRunEvents: mocks.streamRunEvents
}));
vi.mock('$lib/server/project-environments/stream', () => ({
	formatNamedSseEvent: mocks.formatPrepareSseEvent,
	streamProjectEnvironmentPrepare: mocks.streamProjectEnvironmentPrepare
}));
vi.mock('$lib/server/project-environment-services/service', () => ({
	requireProjectEnvironmentServiceForOrg: mocks.requireProjectEnvironmentServiceForOrg,
	ProjectEnvironmentServiceError: class ProjectEnvironmentServiceError extends Error {}
}));
vi.mock('$lib/server/project-environment-services/stream', () => ({
	formatNamedSseEvent: mocks.formatServiceSseEvent,
	streamProjectEnvironmentServiceEvents: mocks.streamProjectEnvironmentServiceEvents
}));

function request() {
	return new Request('http://localhost/events', { headers: new Headers() });
}

async function* emptyStream() {
	// no events needed; tests only verify guards before stream setup
}

describe('SSE permission guards', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.requireActor.mockResolvedValue({ userId: 'u1' });
		mocks.requireRunPermission.mockResolvedValue({
			id: 'r1',
			projectId: 'p1',
			organizationId: 'org1'
		});
		mocks.requireProjectPermission.mockResolvedValue({ id: 'p1', organizationId: 'org1' });
		mocks.runFindFirst.mockResolvedValue({ id: 'r1' });
		mocks.profileFindFirst.mockResolvedValue({ id: 'profile1' });
		mocks.requireProjectEnvironmentServiceForOrg.mockResolvedValue({
			id: 'svc1',
			profileId: 'profile1'
		});
		mocks.parseLastEventIdCursor.mockReturnValue(0);
		mocks.streamRunEvents.mockReturnValue(emptyStream());
		mocks.streamProjectEnvironmentPrepare.mockReturnValue(emptyStream());
		mocks.streamProjectEnvironmentServiceEvents.mockReturnValue(emptyStream());
	});

	it('guards run event streams with run.view before querying or streaming', async () => {
		const { GET } = await import('../../../../src/routes/api/runs/[id]/events/+server');

		const response = await GET({ params: { id: 'r1' }, request: request() } as never);

		expect(response).toBeInstanceOf(Response);
		expect(mocks.requireActor).toHaveBeenCalled();
		expect(mocks.requireRunPermission).toHaveBeenCalledWith({ userId: 'u1' }, 'run.view', 'r1');
		expect(mocks.runFindFirst).toHaveBeenCalledWith({
			where: { id: 'r1', organizationId: 'org1' },
			select: { id: true }
		});
		expect(mocks.requireRunPermission.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.runFindFirst.mock.invocationCallOrder[0]
		);
		expect(mocks.runFindFirst.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.streamRunEvents.mock.invocationCallOrder[0]
		);
	});

	it('rejects denied run event streams before querying or streaming', async () => {
		mocks.requireRunPermission.mockRejectedValueOnce(
			Object.assign(new Error('Forbidden'), { status: 403 })
		);
		const { GET } = await import('../../../../src/routes/api/runs/[id]/events/+server');

		await expect(GET({ params: { id: 'r1' }, request: request() } as never)).rejects.toMatchObject({
			status: 403,
			message: 'Forbidden'
		});

		expect(mocks.runFindFirst).not.toHaveBeenCalled();
		expect(mocks.streamRunEvents).not.toHaveBeenCalled();
	});

	it('guards project environment event streams with project.config.view and owner org', async () => {
		const { GET } =
			await import('../../../../src/routes/api/projects/[id]/environment/[profileId]/events/+server');

		const response = await GET({
			params: { id: 'p1', profileId: 'profile1' },
			request: request()
		} as never);

		expect(response).toBeInstanceOf(Response);
		expect(mocks.requireActor).toHaveBeenCalled();
		expect(mocks.requireProjectPermission).toHaveBeenCalledWith(
			{ userId: 'u1' },
			'project.config.view',
			'p1'
		);
		expect(mocks.profileFindFirst).toHaveBeenCalledWith({
			where: { id: 'profile1', projectId: 'p1', organizationId: 'org1' },
			select: { id: true }
		});
		expect(mocks.requireProjectPermission.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.profileFindFirst.mock.invocationCallOrder[0]
		);
	});

	it('rejects denied project environment event streams before opening the stream', async () => {
		mocks.requireProjectPermission.mockRejectedValueOnce(
			Object.assign(new Error('Forbidden'), { status: 403 })
		);
		const { GET } =
			await import('../../../../src/routes/api/projects/[id]/environment/[profileId]/events/+server');

		await expect(
			GET({ params: { id: 'p1', profileId: 'profile1' }, request: request() } as never)
		).rejects.toMatchObject({
			status: 403,
			message: 'Forbidden'
		});

		expect(mocks.profileFindFirst).not.toHaveBeenCalled();
		expect(mocks.streamProjectEnvironmentPrepare).not.toHaveBeenCalled();
	});

	it('guards project environment service event streams before service lookup', async () => {
		const { GET } =
			await import('../../../../src/routes/api/projects/[id]/environment-services/[serviceId]/events/+server');

		const response = await GET({
			params: { id: 'p1', serviceId: 'svc1' },
			request: request()
		} as never);

		expect(response).toBeInstanceOf(Response);
		expect(mocks.requireActor).toHaveBeenCalled();
		expect(mocks.requireProjectPermission).toHaveBeenCalledWith(
			{ userId: 'u1' },
			'project.config.view',
			'p1'
		);
		expect(mocks.requireProjectEnvironmentServiceForOrg).toHaveBeenCalledWith('org1', 'p1', 'svc1');
		expect(mocks.requireProjectPermission.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.requireProjectEnvironmentServiceForOrg.mock.invocationCallOrder[0]
		);
	});

	it('rejects denied project environment service streams before service lookup', async () => {
		mocks.requireProjectPermission.mockRejectedValueOnce(
			Object.assign(new Error('Forbidden'), { status: 403 })
		);
		const { GET } =
			await import('../../../../src/routes/api/projects/[id]/environment-services/[serviceId]/events/+server');

		await expect(
			GET({ params: { id: 'p1', serviceId: 'svc1' }, request: request() } as never)
		).rejects.toMatchObject({
			status: 403,
			message: 'Forbidden'
		});

		expect(mocks.requireProjectEnvironmentServiceForOrg).not.toHaveBeenCalled();
		expect(mocks.streamProjectEnvironmentServiceEvents).not.toHaveBeenCalled();
	});
});
