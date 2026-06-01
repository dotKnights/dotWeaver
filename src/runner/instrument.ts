// Initialisation Sentry pour le worker (process Node séparé de SvelteKit).
// DOIT être importé en TOUT PREMIER dans `index.ts` pour instrumenter les libs
// (pg, http…) avant qu'elles ne soient chargées.
import * as Sentry from '@sentry/node';
import { env } from '$env/dynamic/private';

const dsn = env.PUBLIC_SENTRY_DSN;

if (dsn) {
	Sentry.init({
		dsn,
		tracesSampleRate: 1.0
	});
}
