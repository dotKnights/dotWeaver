import { describe, expect, it, vi } from 'vitest';
import {
	downloadSkillsShSkill,
	searchSkillsShCatalog,
	SkillsShError
} from '$lib/server/integrations/skills-sh/service';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json' },
		...init
	});
}

describe('skills-sh-service', () => {
	it('uses the authenticated v1 search endpoint when a token is provided', async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse({
				data: [
					{
						id: 'sveltejs/ai-tools/svelte-code-writer',
						slug: 'svelte-code-writer',
						name: 'svelte-code-writer',
						source: 'sveltejs/ai-tools',
						installs: 5568,
						sourceType: 'github',
						installUrl: 'https://github.com/sveltejs/ai-tools',
						url: 'https://skills.sh/sveltejs/ai-tools/svelte-code-writer'
					}
				],
				query: 'svelte',
				searchType: 'fuzzy',
				count: 1
			})
		);

		const result = await searchSkillsShCatalog(
			{ query: 'svelte', limit: 2, token: 'oidc-token' },
			fetchImpl
		);

		expect(fetchImpl).toHaveBeenCalledWith(
			'https://skills.sh/api/v1/skills/search?q=svelte&limit=2',
			{ headers: { Authorization: 'Bearer oidc-token' } }
		);
		expect(result).toEqual({
			query: 'svelte',
			searchType: 'fuzzy',
			count: 1,
			results: [
				{
					id: 'sveltejs/ai-tools/svelte-code-writer',
					slug: 'svelte-code-writer',
					name: 'svelte-code-writer',
					source: 'sveltejs/ai-tools',
					installs: 5568,
					sourceType: 'github',
					installUrl: 'https://github.com/sveltejs/ai-tools',
					url: 'https://skills.sh/sveltejs/ai-tools/svelte-code-writer',
					isDuplicate: false
				}
			]
		});
	});

	it('falls back to the legacy search endpoint when v1 rejects authentication', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(
				jsonResponse(
					{
						error: 'authentication_required',
						message: 'This endpoint requires authentication'
					},
					{ status: 401 }
				)
			)
			.mockResolvedValueOnce(
				jsonResponse({
					query: 'svelte',
					searchType: 'fuzzy',
					skills: [
						{
							id: 'sveltejs/ai-tools/svelte-code-writer',
							skillId: 'svelte-code-writer',
							name: 'svelte-code-writer',
							installs: 5568,
							source: 'sveltejs/ai-tools'
						}
					],
					count: 1
				})
			);

		const result = await searchSkillsShCatalog(
			{ query: 'svelte', limit: 2, token: 'expired-token' },
			fetchImpl
		);

		expect(fetchImpl).toHaveBeenNthCalledWith(
			1,
			'https://skills.sh/api/v1/skills/search?q=svelte&limit=2',
			{ headers: { Authorization: 'Bearer expired-token' } }
		);
		expect(fetchImpl).toHaveBeenNthCalledWith(2, 'https://skills.sh/api/search?q=svelte&limit=2', {
			headers: {}
		});
		expect(result.results[0]).toMatchObject({
			id: 'sveltejs/ai-tools/svelte-code-writer',
			slug: 'svelte-code-writer',
			source: 'sveltejs/ai-tools'
		});
	});

	it('uses the legacy search endpoint directly when no token is provided', async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse({
				query: 'svelte',
				searchType: 'fuzzy',
				skills: [],
				count: 0
			})
		);

		await expect(searchSkillsShCatalog({ query: 'svelte', limit: 2 }, fetchImpl)).resolves.toEqual({
			query: 'svelte',
			searchType: 'fuzzy',
			count: 0,
			results: []
		});
		expect(fetchImpl).toHaveBeenCalledWith('https://skills.sh/api/search?q=svelte&limit=2', {
			headers: {}
		});
	});

	it('normalizes downloaded skill files from v1 detail responses', async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse({
				id: 'vercel-labs/skills/find-skills',
				source: 'vercel-labs/skills',
				slug: 'find-skills',
				installs: 24531,
				hash: 'abc123',
				files: [
					{
						path: 'SKILL.md',
						contents: '---\nname: find-skills\ndescription: Find skills\n---\n\nUse it.'
					},
					{ path: 'examples/demo.md', contents: 'demo' }
				]
			})
		);

		const result = await downloadSkillsShSkill(
			{ id: 'vercel-labs/skills/find-skills', token: 'oidc-token' },
			fetchImpl
		);

		expect(fetchImpl).toHaveBeenCalledWith(
			'https://skills.sh/api/v1/skills/vercel-labs/skills/find-skills',
			{
				headers: { Authorization: 'Bearer oidc-token' }
			}
		);
		expect(result).toEqual({
			id: 'vercel-labs/skills/find-skills',
			name: 'find-skills',
			description: 'Find skills',
			body: '---\nname: find-skills\ndescription: Find skills\n---\n\nUse it.',
			files: [{ path: 'examples/demo.md', content: 'demo' }],
			source: 'vercel-labs/skills',
			slug: 'find-skills',
			hash: 'abc123',
			installs: 24531,
			sourceType: null,
			installUrl: null,
			url: null
		});
	});

	it('falls back to legacy download responses when v1 rejects authentication', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ error: 'authentication_required' }, { status: 401 }))
			.mockResolvedValueOnce(
				jsonResponse({
					hash: 'legacy-hash',
					files: [
						{
							path: 'SKILL.md',
							contents: '---\nname: web-design-guidelines\ndescription: Design UI\n---\n\nUse it.'
						}
					]
				})
			);

		const result = await downloadSkillsShSkill(
			{ id: 'vercel-labs/agent-skills/web-design-guidelines', token: 'expired-token' },
			fetchImpl
		);

		expect(fetchImpl).toHaveBeenNthCalledWith(
			2,
			'https://skills.sh/api/download/vercel-labs/agent-skills/web-design-guidelines',
			{ headers: {} }
		);
		expect(result).toMatchObject({
			id: 'vercel-labs/agent-skills/web-design-guidelines',
			name: 'web-design-guidelines',
			description: 'Design UI',
			hash: 'legacy-hash'
		});
	});

	it.each([
		{ path: '../escape.md', content: 'nope' },
		{ path: '/absolute.md', content: 'nope' },
		{ path: 'dir\\file.md', content: 'nope' },
		{ path: 'dir//file.md', content: 'nope' },
		{ path: 'dir/\u0000/file.md', content: 'nope' }
	])('rejects unsafe downloaded support file path $path', async ({ path, content }) => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse({
				id: 'owner/repo/safe-skill',
				source: 'owner/repo',
				slug: 'safe-skill',
				hash: 'abc123',
				files: [
					{ path: 'SKILL.md', contents: '---\nname: safe-skill\n---\n\nUse it.' },
					{ path, contents: content }
				]
			})
		);

		await expect(downloadSkillsShSkill({ id: 'owner/repo/safe-skill' }, fetchImpl)).rejects.toThrow(
			SkillsShError
		);
	});

	it('rejects downloads without a SKILL.md file', async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse({
				id: 'owner/repo/missing',
				source: 'owner/repo',
				slug: 'missing',
				files: [{ path: 'README.md', contents: 'no skill' }]
			})
		);

		await expect(downloadSkillsShSkill({ id: 'owner/repo/missing' }, fetchImpl)).rejects.toThrow(
			'Downloaded skill must include SKILL.md'
		);
	});
});
