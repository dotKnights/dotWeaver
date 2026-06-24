import { prisma } from '$lib/server/prisma';

export const PROJECT_ENVIRONMENT_SERVICE_CHANNEL = 'project_environment_service';

export type ProjectEnvironmentServiceNotification = {
	organizationId: string;
	projectId: string;
	profileId: string;
	serviceId: string;
	kind: 'event' | 'service';
	seq?: number;
};

type NotifyDatabase = {
	$executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseProjectEnvironmentServiceNotification(
	payload: string | null | undefined
): ProjectEnvironmentServiceNotification | null {
	if (!payload) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(payload);
	} catch {
		return null;
	}
	if (!isRecord(parsed)) return null;
	if (typeof parsed.organizationId !== 'string' || parsed.organizationId.length === 0) return null;
	if (typeof parsed.projectId !== 'string' || parsed.projectId.length === 0) return null;
	if (typeof parsed.profileId !== 'string' || parsed.profileId.length === 0) return null;
	if (typeof parsed.serviceId !== 'string' || parsed.serviceId.length === 0) return null;
	if (parsed.kind !== 'event' && parsed.kind !== 'service') return null;
	if (
		parsed.seq !== undefined &&
		(typeof parsed.seq !== 'number' || !Number.isInteger(parsed.seq) || parsed.seq < 0)
	) {
		return null;
	}
	return {
		organizationId: parsed.organizationId,
		projectId: parsed.projectId,
		profileId: parsed.profileId,
		serviceId: parsed.serviceId,
		kind: parsed.kind,
		...(parsed.seq === undefined ? {} : { seq: parsed.seq })
	};
}

export async function notifyProjectEnvironmentService(
	notification: ProjectEnvironmentServiceNotification,
	db: NotifyDatabase = prisma
): Promise<void> {
	await db.$executeRaw`SELECT pg_notify(${PROJECT_ENVIRONMENT_SERVICE_CHANNEL}, ${JSON.stringify(
		notification
	)})`;
}
