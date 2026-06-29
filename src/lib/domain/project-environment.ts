import {
	ProjectEnvironmentPackageManager as PrismaProjectEnvironmentPackageManager,
	ProjectEnvironmentRuntime as PrismaProjectEnvironmentRuntime,
	type ProjectEnvironmentPackageManager,
	type ProjectEnvironmentRuntime
} from '@prisma/client';

export type {
	ProjectEnvironmentPackageManager,
	ProjectEnvironmentPrepareEventType,
	ProjectEnvironmentRuntime
} from '@prisma/client';

export const PROJECT_ENVIRONMENT_RUNTIMES = Object.values(
	PrismaProjectEnvironmentRuntime
) as readonly ProjectEnvironmentRuntime[];

export const PROJECT_ENVIRONMENT_PACKAGE_MANAGERS = Object.values(
	PrismaProjectEnvironmentPackageManager
) as readonly ProjectEnvironmentPackageManager[];

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
