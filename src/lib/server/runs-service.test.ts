import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/prisma', () => ({
	prisma: { run: { findMany: vi.fn(), findFirst: vi.fn() } }
}));
vi.mock('$lib/server/diff', () => ({ computeDiff: vi.fn() }));
vi.mock('node:fs', () => ({ existsSync: vi.fn() }));

import { prisma } from '$lib/server/prisma';
import { computeDiff } from '$lib/server/diff';
import { existsSync } from 'node:fs';
import {
	listRunsForOrg,
	getRunForOrg,
	getRunDiffForOrg,
	RunWorkspaceUnavailableError
} from './runs-service';

describe('runs-service', () => {
	beforeEach(() => vi.clearAllMocks());

	it('listRunsForOrg scope projet + org, trie queuedAt desc', async () => {
		(prisma.run.findMany as any).mockResolvedValue([{ id: 'r1' }]);
		await listRunsForOrg('org1', 'p1');
		expect(prisma.run.findMany).toHaveBeenCalledWith(
			expect.objectContaining({ where: { projectId: 'p1', organizationId: 'org1' } })
		);
	});

	it('getRunForOrg inclut les events ordonnes', async () => {
		(prisma.run.findFirst as any).mockResolvedValue({ id: 'r1' });
		await getRunForOrg('org1', 'r1');
		expect(prisma.run.findFirst).toHaveBeenCalledWith({
			where: { id: 'r1', organizationId: 'org1' },
			include: { events: { orderBy: { seq: 'asc' } } }
		});
	});

	it('getRunForOrg renvoie null hors org', async () => {
		(prisma.run.findFirst as any).mockResolvedValue(null);
		expect(await getRunForOrg('org1', 'x')).toBeNull();
	});

	it('getRunDiffForOrg renvoie diff vide si pas de SHAs', async () => {
		(prisma.run.findFirst as any).mockResolvedValue({ id: 'r1', baseCommitSha: null });
		expect(await getRunDiffForOrg('org1', 'r1')).toEqual({ files: [], patch: '', truncated: false });
	});

	it('getRunDiffForOrg leve RunWorkspaceUnavailableError si checkout absent', async () => {
		(prisma.run.findFirst as any).mockResolvedValue({
			id: 'r1', projectId: 'p1', baseCommitSha: 'a', headCommitSha: 'b'
		});
		(existsSync as any).mockReturnValue(false);
		await expect(getRunDiffForOrg('org1', 'r1')).rejects.toBeInstanceOf(
			RunWorkspaceUnavailableError
		);
	});

	it('getRunDiffForOrg calcule le diff si checkout present', async () => {
		(prisma.run.findFirst as any).mockResolvedValue({
			id: 'r1', projectId: 'p1', baseCommitSha: 'a', headCommitSha: 'b'
		});
		(existsSync as any).mockReturnValue(true);
		(computeDiff as any).mockResolvedValue({ files: [], patch: 'x', truncated: false });
		const res = await getRunDiffForOrg('org1', 'r1');
		expect(res).toEqual({ files: [], patch: 'x', truncated: false });
	});
});
