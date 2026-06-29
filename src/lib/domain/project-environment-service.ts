import {
	ProjectEnvironmentServiceKind as PrismaProjectEnvironmentServiceKind,
	ProjectEnvironmentServiceStatus as PrismaProjectEnvironmentServiceStatus,
	type ProjectEnvironmentServiceKind,
	type ProjectEnvironmentServiceStatus
} from '@prisma/client';

export type {
	ProjectEnvironmentServiceKind,
	ProjectEnvironmentServiceStatus
} from '@prisma/client';

export const PROJECT_ENVIRONMENT_SERVICE_KINDS = Object.values(
	PrismaProjectEnvironmentServiceKind
) as readonly ProjectEnvironmentServiceKind[];

export const PROJECT_ENVIRONMENT_SERVICE_STATUSES = Object.values(
	PrismaProjectEnvironmentServiceStatus
) as readonly ProjectEnvironmentServiceStatus[];
