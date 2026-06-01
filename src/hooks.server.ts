import * as Sentry from '@sentry/sveltekit';
import { handleErrorWithSentry, sentryHandle } from '@sentry/sveltekit';
import { auth } from '$lib/server/auth';
import { svelteKitHandler } from 'better-auth/svelte-kit';
import { building } from '$app/environment';
import { sequence } from '@sveltejs/kit/hooks';
import type { Handle } from '@sveltejs/kit';
import { installProcessSafetyNet } from '$lib/server/process-safety';
import { env } from '$env/dynamic/public';

Sentry.init({
	dsn: env.PUBLIC_SENTRY_DSN,
	// Désactivé proprement si le DSN n'est pas fourni (dev local sans Sentry).
	enabled: Boolean(env.PUBLIC_SENTRY_DSN),
	tracesSampleRate: 1.0
});

installProcessSafetyNet('sveltekit');

const authHandle: Handle = async ({ event, resolve }) => {
	const session = await auth.api.getSession({ headers: event.request.headers });
	event.locals.session = session?.session ?? null;
	event.locals.user = session?.user ?? null;

	return svelteKitHandler({ event, resolve, auth, building });
};

// `sentryHandle` doit envelopper l'app pour tracer les requêtes et capturer les erreurs serveur.
export const handle: Handle = sequence(sentryHandle(), authHandle);

// Capture les erreurs non gérées côté serveur (load, actions, endpoints).
export const handleError = handleErrorWithSentry();
