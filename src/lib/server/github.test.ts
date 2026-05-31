import { describe, it, expect } from 'vitest';
import { mapRepoListItem, mapRepoToProjectInput, type GithubRepo } from './github';

const repo: GithubRepo = {
	id: 12345,
	name: 'my-repo',
	full_name: 'octocat/my-repo',
	private: true,
	default_branch: 'main',
	clone_url: 'https://github.com/octocat/my-repo.git',
	owner: { login: 'octocat' }
};

describe('mapRepoListItem', () => {
	it('projects a GitHub repo into a list item', () => {
		expect(mapRepoListItem(repo)).toEqual({
			githubRepoId: '12345',
			owner: 'octocat',
			name: 'my-repo',
			fullName: 'octocat/my-repo',
			private: true,
			defaultBranch: 'main'
		});
	});
});

describe('mapRepoToProjectInput', () => {
	it('builds a Prisma create input scoped to org + importer', () => {
		expect(mapRepoToProjectInput(repo, 'org_1', 'user_1')).toEqual({
			organizationId: 'org_1',
			githubRepoId: '12345',
			owner: 'octocat',
			name: 'my-repo',
			defaultBranch: 'main',
			cloneUrl: 'https://github.com/octocat/my-repo.git',
			private: true,
			importedById: 'user_1'
		});
	});
});
