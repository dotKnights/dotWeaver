export const PROJECT_ENVIRONMENT_RUNTIMES = ['node', 'python', 'custom'] as const;
export type ProjectEnvironmentRuntime = (typeof PROJECT_ENVIRONMENT_RUNTIMES)[number];

export const PROJECT_ENVIRONMENT_PACKAGE_MANAGERS = [
	'bun',
	'npm',
	'pnpm',
	'yarn',
	'uv',
	'pip',
	'poetry',
	'custom'
] as const;
export type ProjectEnvironmentPackageManager =
	(typeof PROJECT_ENVIRONMENT_PACKAGE_MANAGERS)[number];

export const PROJECT_ENVIRONMENT_STATUSES = [
	'unconfigured',
	'detected',
	'ready',
	'invalid'
] as const;
export type ProjectEnvironmentStatus = (typeof PROJECT_ENVIRONMENT_STATUSES)[number];

export const PROJECT_ENVIRONMENT_PREPARE_STATUSES = [
	'never',
	'running',
	'succeeded',
	'failed'
] as const;
export type ProjectEnvironmentPrepareStatus =
	(typeof PROJECT_ENVIRONMENT_PREPARE_STATUSES)[number];

export const PROJECT_ENVIRONMENT_PREPARE_EVENT_TYPES = [
	'system',
	'output',
	'error',
	'result'
] as const;
export type ProjectEnvironmentPrepareEventType =
	(typeof PROJECT_ENVIRONMENT_PREPARE_EVENT_TYPES)[number];

export const NODE_PACKAGE_MANAGERS = ['bun', 'npm', 'pnpm', 'yarn'] as const;
export const PYTHON_PACKAGE_MANAGERS = ['uv', 'pip', 'poetry'] as const;
