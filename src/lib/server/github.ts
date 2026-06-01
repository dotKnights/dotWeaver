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

/**
 * Récupère un access token GitHub frais via better-auth (jamais persisté ailleurs).
 * Renvoie `null` si le compte GitHub n'est pas lié (better-auth lève `ACCOUNT_NOT_FOUND`)
 * ou si le token est indisponible. On NE laisse PAS l'APIError remonter : non catchée,
 * elle produit une unhandled rejection qui crashe le process serveur (DOT-16 bug).
 */
export async function getGithubToken(headers: Headers): Promise<string | null> {
	try {
		const res = await auth.api.getAccessToken({ body: { providerId: 'github' }, headers });
		return res?.accessToken ?? null;
	} catch {
		return null;
	}
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

const REPOS_PER_PAGE = 100;
/** Nombre max de pages parcourues (garde-fou : REPOS_PER_PAGE * MAX = 1000 repos). */
const MAX_REPO_PAGES = 10;

/** Récupère une page de repos accessibles à l'utilisateur (100/page). */
export async function listUserRepos(token: string, page = 1): Promise<RepoListItem[]> {
	const res = await githubFetch(
		token,
		`/user/repos?per_page=${REPOS_PER_PAGE}&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`
	);
	if (!res.ok) throw new Error(`GitHub list repos failed: ${res.status}`);
	const repos = (await res.json()) as GithubRepo[];
	return repos.map(mapRepoListItem);
}

/**
 * Liste tous les repos accessibles en paginant jusqu'à épuisement (page pleine =
 * il reste potentiellement des résultats), avec un garde-fou à MAX_REPO_PAGES.
 */
export async function listAllUserRepos(token: string): Promise<RepoListItem[]> {
	const all: RepoListItem[] = [];
	for (let page = 1; page <= MAX_REPO_PAGES; page++) {
		const batch = await listUserRepos(token, page);
		all.push(...batch);
		if (batch.length < REPOS_PER_PAGE) break;
	}
	return all;
}

/** Détail d'un repo précis (source de vérité côté serveur lors de l'import). */
export async function getRepo(token: string, owner: string, name: string): Promise<GithubRepo> {
	const res = await githubFetch(token, `/repos/${owner}/${name}`);
	if (!res.ok) throw new Error(`GitHub get repo failed: ${res.status}`);
	return (await res.json()) as GithubRepo;
}
