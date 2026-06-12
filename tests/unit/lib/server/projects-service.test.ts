import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('$lib/server/prisma', () => ({
	prisma: {
		project: { findMany: vi.fn(), findFirst: vi.fn() }
	}
}));

import { prisma } from '$lib/server/prisma';
import { listProjectsForOrg, getProjectForOrg } from '$lib/server/projects-service';

type ProjectRow = { id: string };

const findMany = vi.mocked(prisma.project.findMany) as unknown as Mock<() => Promise<ProjectRow[]>>;
const findFirst = vi.mocked(prisma.project.findFirst) as unknown as Mock<
	() => Promise<ProjectRow | null>
>;

describe('projects-service', () => {
	beforeEach(() => vi.clearAllMocks());

	it('listProjectsForOrg scope par organizationId, trié récent', async () => {
		findMany.mockResolvedValue([{ id: 'p1' }]);
		const res = await listProjectsForOrg('org1');
		expect(prisma.project.findMany).toHaveBeenCalledWith({
			where: { organizationId: 'org1' },
			orderBy: { createdAt: 'desc' }
		});
		expect(res).toEqual([{ id: 'p1' }]);
	});

	it("getProjectForOrg renvoie le projet si trouvé dans l'org", async () => {
		findFirst.mockResolvedValue({ id: 'p1' });
		expect(await getProjectForOrg('org1', 'p1')).toEqual({ id: 'p1' });
		expect(prisma.project.findFirst).toHaveBeenCalledWith({
			where: { id: 'p1', organizationId: 'org1' }
		});
	});

	it('getProjectForOrg renvoie null si absent/hors org', async () => {
		findFirst.mockResolvedValue(null);
		expect(await getProjectForOrg('org1', 'nope')).toBeNull();
	});
});
