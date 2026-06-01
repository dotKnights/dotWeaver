import * as Sentry from '@sentry/sveltekit';
import { handleErrorWithSentry, replayIntegration } from '@sentry/sveltekit';
import { env } from '$env/dynamic/public';

Sentry.init({
	dsn: env.PUBLIC_SENTRY_DSN,
	// Désactivé proprement si le DSN n'est pas fourni (dev local sans Sentry).
	enabled: Boolean(env.PUBLIC_SENTRY_DSN),

	// Performance monitoring : 100% en dev, à abaisser en prod si volume élevé.
	tracesSampleRate: 1.0,

	// Session Replay : 10% des sessions, 100% de celles où une erreur survient.
	integrations: [replayIntegration()],
	replaysSessionSampleRate: 0.1,
	replaysOnErrorSampleRate: 1.0
});

// Capture les erreurs survenant pendant le rendu côté client.
export const handleError = handleErrorWithSentry();
