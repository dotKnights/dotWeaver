import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { handleGithubWebhook } from '$lib/server/github-triggers/webhook-handler';

/**
 * Endpoint webhook GitHub — délibérément hors du périmètre Better Auth : il n'y a ni
 * session ni cookie, l'authentification repose uniquement sur la signature HMAC-SHA256.
 * URL enregistrée sur GitHub : /api/github/webhook?orgId=<orgId>
 */
export const POST: RequestHandler = async ({ request, url }) => {
	// Le corps brut doit être lu tel quel : toute normalisation invaliderait la signature.
	const rawBody = await request.text();

	const result = await handleGithubWebhook({
		rawBody,
		organizationId: url.searchParams.get('orgId'),
		headers: {
			signature: request.headers.get('x-hub-signature-256') ?? '',
			event: request.headers.get('x-github-event') ?? '',
			deliveryId: request.headers.get('x-github-delivery') ?? ''
		}
	});

	// GitHub ne doit pas rejouer nos erreurs de traitement : seul un défaut de signature
	// (qu'un retry ne corrigera jamais) renvoie un 400.
	if (result.status === 'invalid_signature') {
		return json({ error: 'Invalid signature' }, { status: 400 });
	}

	return json({ received: true, deliveryId: result.deliveryId }, { status: 200 });
};
