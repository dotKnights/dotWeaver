import {
	ProjectEnvironmentServiceEventType as PrismaProjectEnvironmentServiceEventType,
	ProjectEnvironmentServiceKind as PrismaProjectEnvironmentServiceKind,
	ProjectEnvironmentServiceStatus as PrismaProjectEnvironmentServiceStatus,
	type ProjectEnvironmentServiceEventType,
	type ProjectEnvironmentServiceKind,
	type ProjectEnvironmentServiceStatus
} from '@prisma/client';

export type {
	ProjectEnvironmentServiceEventType,
	ProjectEnvironmentServiceKind,
	ProjectEnvironmentServiceStatus
} from '@prisma/client';

export const PROJECT_ENVIRONMENT_SERVICE_KINDS = Object.values(
	PrismaProjectEnvironmentServiceKind
) as readonly ProjectEnvironmentServiceKind[];

export const PROJECT_ENVIRONMENT_SERVICE_STATUSES = Object.values(
	PrismaProjectEnvironmentServiceStatus
) as readonly ProjectEnvironmentServiceStatus[];

export const PROJECT_ENVIRONMENT_SERVICE_EVENT_TYPES = Object.values(
	PrismaProjectEnvironmentServiceEventType
) as readonly ProjectEnvironmentServiceEventType[];
