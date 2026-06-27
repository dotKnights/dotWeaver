export const PROJECT_ENVIRONMENT_SERVICE_KINDS = ['postgres', 'redis'] as const;
export type ProjectEnvironmentServiceKind = (typeof PROJECT_ENVIRONMENT_SERVICE_KINDS)[number];

export const PROJECT_ENVIRONMENT_SERVICE_STATUSES = [
	'configured',
	'provisioning',
	'ready',
	'failed',
	'disabled'
] as const;
export type ProjectEnvironmentServiceStatus = (typeof PROJECT_ENVIRONMENT_SERVICE_STATUSES)[number];

export const PROJECT_ENVIRONMENT_SERVICE_EVENT_TYPES = [
	'system',
	'output',
	'error',
	'result'
] as const;
export type ProjectEnvironmentServiceEventType =
	(typeof PROJECT_ENVIRONMENT_SERVICE_EVENT_TYPES)[number];
