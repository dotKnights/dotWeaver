import { auth } from '$lib/server/auth';
import { svelteKitHandler } from 'better-auth/svelte-kit';
import { building } from '$app/environment';
import type { Handle } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import * as Sentry from '@sentry/sveltekit';

Sentry.init({
	dsn: 'https://90f2e76876b2de08ed26a4dd3c0c0faa@o4511490290221056.ingest.de.sentry.io/4511490291925073',
	tracesSampleRate: 1.0
});

export const handleError = Sentry.handleErrorWithSentry();

const authHandle: Handle = async ({ event, resolve }) => {
	const session = await auth.api.getSession({ headers: event.request.headers });
	event.locals.session = session?.session ?? null;
	event.locals.user = session?.user ?? null;

	return svelteKitHandler({ event, resolve, auth, building });
};

export const handle = sequence(Sentry.sentryHandle(), authHandle);
