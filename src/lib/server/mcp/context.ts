import { listTeamsForUser } from '$lib/server/teams/service';

/** L'utilisateur a plusieurs orgs et n'a pas precise "team". */
export class AmbiguousTeamError extends Error {
	constructor(public slugs: string[]) {
		super(`Multiple teams available - specify one of: ${slugs.join(', ')}`);
		this.name = 'AmbiguousTeamError';
	}
}
/** "team" fourni mais l'utilisateur n'en est pas membre (ou n'existe pas). */
export class TeamAccessError extends Error {
	constructor() {
		super('Access denied to the requested team');
		this.name = 'TeamAccessError';
	}
}
/** L'utilisateur n'appartient a aucune org. */
export class NoTeamError extends Error {
	constructor() {
		super('You are not a member of any team');
		this.name = 'NoTeamError';
	}
}

/**
 * Resout l'organizationId pour un appel MCP.
 * - "teamSlug" fourni -> doit correspondre a une org dont l'user est membre.
 * - sinon -> defaut si une seule org ; AmbiguousTeamError si plusieurs ; NoTeamError si zero.
 * Fail-closed : aucune valeur permissive par defaut.
 */
export async function resolveOrgContext(userId: string, teamSlug?: string): Promise<string> {
	const teams = await listTeamsForUser(userId);
	if (teamSlug) {
		const match = teams.find((t) => t.slug === teamSlug);
		if (!match) throw new TeamAccessError();
		return match.id;
	}
	if (teams.length === 0) throw new NoTeamError();
	if (teams.length === 1) return teams[0].id;
	throw new AmbiguousTeamError(teams.map((t) => t.slug));
}
