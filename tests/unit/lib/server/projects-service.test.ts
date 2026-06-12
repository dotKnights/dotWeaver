import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/prisma', () => ({
	prisma: {
		project: { findMany: vi.fn(), findFirst: vi.fn() }
	}
}));

import { prisma } from '$lib/server/prisma';
import { listProjectsForOrg, getProjectForOrg } from '$lib/server/projects-service';

describe('projects-service', () => {
	beforeEach(() => vi.clearAllMocks());

	it('listProjectsForOrg scope par organizationId, trié récent', async () => {
		(prisma.project.findMany as any).mockResolvedValue([{ id: 'p1' }]);
		const res = await listProjectsForOrg('org1');
		expect(prisma.project.findMany).toHaveBeenCalledWith({
			where: { organizationId: 'org1' },
			orderBy: { createdAt: 'desc' }
		});
		expect(res).toEqual([{ id: 'p1' }]);
	});

	it("getProjectForOrg renvoie le projet si trouvé dans l'org", async () => {
		(prisma.project.findFirst as any).mockResolvedValue({ id: 'p1' });
		expect(await getProjectForOrg('org1', 'p1')).toEqual({ id: 'p1' });
		expect(prisma.project.findFirst).toHaveBeenCalledWith({
			where: { id: 'p1', organizationId: 'org1' }
		});
	});

	it('getProjectForOrg renvoie null si absent/hors org', async () => {
		(prisma.project.findFirst as any).mockResolvedValue(null);
		expect(await getProjectForOrg('org1', 'nope')).toBeNull();
	});
});
