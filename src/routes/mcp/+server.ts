import type { RequestHandler } from './$types';
import { withMcpAuth } from 'better-auth/plugins';
import { auth } from '$lib/server/auth';
import { createDotweaverMcpHandler } from '$lib/server/mcp/server';

/**
 * withMcpAuth valide le Bearer (401 + WWW-Authenticate si invalide) et fournit la session.
 * session est OAuthAccessToken avec session.userId : string.
 */
const protectedHandler = withMcpAuth(auth, (req, session) => {
	const handler = createDotweaverMcpHandler(session.userId);
	return handler(req);
});

export const POST: RequestHandler = ({ request }) => protectedHandler(request);
export const GET: RequestHandler = ({ request }) => protectedHandler(request);
export const DELETE: RequestHandler = ({ request }) => protectedHandler(request);
