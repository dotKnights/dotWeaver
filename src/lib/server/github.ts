import { auth } from '$lib/server/auth';

export interface GithubRepo {
	id: number;
	name: string;
	full_name: string;
	private: boolean;
	default_branch: string;
	clone_url: string;
	owner: { login: string };
}

export interface RepoListItem {
	githubRepoId: string;
	owner: string;
	name: string;
	fullName: string;
	private: boolean;
	defaultBranch: string;
}

export function mapRepoListItem(repo: GithubRepo): RepoListItem {
	return {
		githubRepoId: String(repo.id),
		owner: repo.owner.login,
		name: repo.name,
		fullName: repo.full_name,
		private: repo.private,
		defaultBranch: repo.default_branch
	};
}

export function mapRepoToProjectInput(
	repo: GithubRepo,
	organizationId: string,
	importedById: string
) {
	return {
		organizationId,
		githubRepoId: String(repo.id),
		owner: repo.owner.login,
		name: repo.name,
		defaultBranch: repo.default_branch,
		cloneUrl: repo.clone_url,
		private: repo.private,
		importedById
	};
}

/** Récupère un access token GitHub frais via better-auth (jamais persisté ailleurs). */
export async function getGithubToken(headers: Headers): Promise<string> {
	const res = await auth.api.getAccessToken({ body: { providerId: 'github' }, headers });
	if (!res?.accessToken) throw new Error('No GitHub access token');
	return res.accessToken;
}

async function githubFetch(token: string, path: string): Promise<Response> {
	return fetch(`https://api.github.com${path}`, {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28'
		}
	});
}

/** Liste les repos accessibles à l'utilisateur (page par page, 100/page). */
export async function listUserRepos(token: string, page = 1): Promise<RepoListItem[]> {
	const res = await githubFetch(
		token,
		`/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`
	);
	if (!res.ok) throw new Error(`GitHub list repos failed: ${res.status}`);
	const repos = (await res.json()) as GithubRepo[];
	return repos.map(mapRepoListItem);
}

/** Détail d'un repo précis (source de vérité côté serveur lors de l'import). */
export async function getRepo(token: string, owner: string, name: string): Promise<GithubRepo> {
	const res = await githubFetch(token, `/repos/${owner}/${name}`);
	if (!res.ok) throw new Error(`GitHub get repo failed: ${res.status}`);
	return (await res.json()) as GithubRepo;
}
