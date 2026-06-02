import { auth } from '$lib/server/auth';
import { svelteKitHandler } from 'better-auth/svelte-kit';
import { building } from '$app/environment';
import type { Handle } from '@sveltejs/kit';
import { installProcessSafetyNet } from '$lib/server/process-safety';

installProcessSafetyNet('sveltekit');

/**
 * Chemins publics du serveur MCP + flow OAuth qui doivent etre joignables par des
 * clients navigateur (MCP Inspector, connecteur web Claude.ai). better-auth ne pose
 * pas systematiquement les en-tetes CORS sur ses endpoints `/api/auth/*` (notamment
 * `/.well-known/oauth-protected-resource`, cible du header WWW-Authenticate), ce qui
 * fait echouer le fetch cross-origin du navigateur ("TypeError: Failed to fetch").
 * On ajoute donc le CORS ici, scope a ces seuls chemins. Tokens en header Bearer
 * (pas de cookie) => `*` est sans risque de fuite de session.
 */
function needsCors(pathname: string): boolean {
	return (
		pathname === '/mcp' ||
		pathname.startsWith('/.well-known/') ||
		pathname.startsWith('/api/auth/mcp') ||
		pathname.startsWith('/api/auth/.well-known')
	);
}

function applyCors(headers: Headers): void {
	headers.set('Access-Control-Allow-Origin', '*');
	headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
	headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-protocol-version, mcp-session-id');
	headers.set('Access-Control-Expose-Headers', 'WWW-Authenticate, mcp-session-id, mcp-protocol-version');
	headers.set('Access-Control-Max-Age', '86400');
}

export const handle: Handle = async ({ event, resolve }) => {
	const cors = needsCors(event.url.pathname);

	// Preflight CORS : repondre immediatement, sans toucher a better-auth/mcp-handler.
	if (cors && event.request.method === 'OPTIONS') {
		const headers = new Headers();
		applyCors(headers);
		return new Response(null, { status: 204, headers });
	}

	const session = await auth.api.getSession({ headers: event.request.headers });
	event.locals.session = session?.session ?? null;
	event.locals.user = session?.user ?? null;

	const response = await svelteKitHandler({ event, resolve, auth, building });
	if (cors) applyCors(response.headers);

	// Logging temporaire de debug du flow MCP/OAuth (sans valeurs sensibles).
	// A retirer une fois la connexion des clients MCP (Poke, Inspector) validee.
	const p = event.url.pathname;
	if (p === '/mcp' || p.startsWith('/api/auth/mcp') || p.startsWith('/.well-known/') || p.startsWith('/api/auth/.well-known')) {
		const hasBearer = (event.request.headers.get('authorization') ?? '').toLowerCase().startsWith('bearer ');
		const accept = event.request.headers.get('accept') ?? '';
		console.log(
			`[mcp] ${event.request.method} ${p}${event.url.search} -> ${response.status}` +
				` bearer=${hasBearer} accept="${accept}" ua="${event.request.headers.get('user-agent') ?? ''}"`
		);
	}

	return response;
};
