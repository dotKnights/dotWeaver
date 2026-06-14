import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	git: vi.fn(),
	authedCloneUrl: vi.fn(),
	makeGitAuth: vi.fn(),
	ensureMirror: vi.fn(),
	listMirrorBranches: vi.fn()
}));

vi.mock('$lib/server/git', () => ({
	git: mocks.git
}));
vi.mock('$lib/server/github-git', () => ({
	authedCloneUrl: mocks.authedCloneUrl,
	makeGitAuth: mocks.makeGitAuth
}));
vi.mock('$lib/server/workspace', () => ({
	ensureMirror: mocks.ensureMirror,
	listMirrorBranches: mocks.listMirrorBranches
}));

import {
	assertValidBranchName,
	orderProjectBranches
} from '$lib/server/project-branches-service';

describe('project-branches-service', () => {
	beforeEach(() => vi.resetAllMocks());

	it('orders the default branch first and de-duplicates names', () => {
		expect(orderProjectBranches(['feature/login', 'main', 'feature/login'], 'main')).toEqual([
			'main',
			'feature/login'
		]);
	});

	it('keeps non-default branches sorted alphabetically', () => {
		expect(orderProjectBranches(['zeta', 'main', 'alpha'], 'main')).toEqual([
			'main',
			'alpha',
			'zeta'
		]);
	});

	it('accepts a valid branch name through git check-ref-format', async () => {
		mocks.git.mockResolvedValue({ code: 0, stdout: 'feature/login\n', stderr: '' });

		await expect(assertValidBranchName('feature/login')).resolves.toBeUndefined();
		expect(mocks.git).toHaveBeenCalledWith(['check-ref-format', '--branch', 'feature/login'], {
			env: expect.any(Object)
		});
	});

	it('rejects an invalid branch name', async () => {
		mocks.git.mockResolvedValue({ code: 1, stdout: '', stderr: 'fatal: invalid ref' });

		await expect(assertValidBranchName('bad..branch')).rejects.toThrow(
			'Invalid base branch name'
		);
	});
});
