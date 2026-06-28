import {
	ProjectEnvironmentPackageManager as PrismaProjectEnvironmentPackageManager,
	ProjectEnvironmentPrepareEventType as PrismaProjectEnvironmentPrepareEventType,
	ProjectEnvironmentPrepareStatus as PrismaProjectEnvironmentPrepareStatus,
	ProjectEnvironmentRuntime as PrismaProjectEnvironmentRuntime,
	ProjectEnvironmentStatus as PrismaProjectEnvironmentStatus,
	type ProjectEnvironmentPackageManager,
	type ProjectEnvironmentPrepareEventType,
	type ProjectEnvironmentPrepareStatus,
	type ProjectEnvironmentRuntime,
	type ProjectEnvironmentStatus
} from '@prisma/client';

export type {
	ProjectEnvironmentPackageManager,
	ProjectEnvironmentPrepareEventType,
	ProjectEnvironmentPrepareStatus,
	ProjectEnvironmentRuntime,
	ProjectEnvironmentStatus
} from '@prisma/client';

export const PROJECT_ENVIRONMENT_RUNTIMES = Object.values(
	PrismaProjectEnvironmentRuntime
) as readonly ProjectEnvironmentRuntime[];

export const PROJECT_ENVIRONMENT_PACKAGE_MANAGERS = Object.values(
	PrismaProjectEnvironmentPackageManager
) as readonly ProjectEnvironmentPackageManager[];

export const PROJECT_ENVIRONMENT_STATUSES = Object.values(
	PrismaProjectEnvironmentStatus
) as readonly ProjectEnvironmentStatus[];

export const PROJECT_ENVIRONMENT_PREPARE_STATUSES = Object.values(
	PrismaProjectEnvironmentPrepareStatus
) as readonly ProjectEnvironmentPrepareStatus[];

export const PROJECT_ENVIRONMENT_PREPARE_EVENT_TYPES = Object.values(
	PrismaProjectEnvironmentPrepareEventType
) as readonly ProjectEnvironmentPrepareEventType[];

export const NODE_PACKAGE_MANAGERS = [
	PrismaProjectEnvironmentPackageManager.bun,
	PrismaProjectEnvironmentPackageManager.npm,
	PrismaProjectEnvironmentPackageManager.pnpm,
	PrismaProjectEnvironmentPackageManager.yarn
] as const satisfies readonly ProjectEnvironmentPackageManager[];

export const PYTHON_PACKAGE_MANAGERS = [
	PrismaProjectEnvironmentPackageManager.uv,
	PrismaProjectEnvironmentPackageManager.pip,
	PrismaProjectEnvironmentPackageManager.poetry
] as const satisfies readonly ProjectEnvironmentPackageManager[];
