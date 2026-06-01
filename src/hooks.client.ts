import * as Sentry from '@sentry/sveltekit';

Sentry.init({
	dsn: 'https://90f2e76876b2de08ed26a4dd3c0c0faa@o4511490290221056.ingest.de.sentry.io/4511490291925073',
	tracesSampleRate: 1.0
});

export const handleError = Sentry.handleErrorWithSentry();
