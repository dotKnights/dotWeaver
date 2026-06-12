import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/prisma', () => ({
	prisma: { member: { findMany: vi.fn() } }
}));

import { prisma } from '$lib/server/prisma';
import { resolveOrgContext, AmbiguousTeamError, TeamAccessError, NoTeamError } from '$lib/server/mcp/context';

const membership = (slug: string, orgId: string, role = 'member') => ({
	role,
	organization: { id: orgId, slug, name: slug }
});

describe('resolveOrgContext', () => {
	beforeEach(() => vi.clearAllMocks());

	it('une seule org, pas de team -> defaut sur cette org', async () => {
		(prisma.member.findMany as any).mockResolvedValue([membership('acme', 'org1')]);
		expect(await resolveOrgContext('u1')).toBe('org1');
	});

	it('team fourni et membre -> cette org', async () => {
		(prisma.member.findMany as any).mockResolvedValue([
			membership('acme', 'org1'), membership('globex', 'org2')
		]);
		expect(await resolveOrgContext('u1', 'globex')).toBe('org2');
	});

	it('team fourni mais non membre -> TeamAccessError', async () => {
		(prisma.member.findMany as any).mockResolvedValue([membership('acme', 'org1')]);
		await expect(resolveOrgContext('u1', 'globex')).rejects.toBeInstanceOf(TeamAccessError);
	});

	it('plusieurs orgs sans team -> AmbiguousTeamError listant les slugs', async () => {
		(prisma.member.findMany as any).mockResolvedValue([
			membership('acme', 'org1'), membership('globex', 'org2')
		]);
		const err = await resolveOrgContext('u1').catch((e) => e);
		expect(err).toBeInstanceOf(AmbiguousTeamError);
		expect(err.slugs).toEqual(['acme', 'globex']);
	});

	it('aucune org -> NoTeamError', async () => {
		(prisma.member.findMany as any).mockResolvedValue([]);
		await expect(resolveOrgContext('u1')).rejects.toBeInstanceOf(NoTeamError);
	});
});
