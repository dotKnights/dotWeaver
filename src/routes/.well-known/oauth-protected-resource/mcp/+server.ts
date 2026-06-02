import type { RequestHandler } from './$types';
import { oAuthProtectedResourceMetadata } from 'better-auth/plugins';
import { auth } from '$lib/server/auth';

// RFC 9728 : pour une ressource a `<base>/mcp`, les clients (ex. Poke) demandent la
// metadata au chemin suffixe `/.well-known/oauth-protected-resource/mcp`, pas seulement
// au chemin nu. On sert la meme metadata ici. Voir aussi `../+server.ts`.
export const GET: RequestHandler = ({ request }) => oAuthProtectedResourceMetadata(auth)(request);
