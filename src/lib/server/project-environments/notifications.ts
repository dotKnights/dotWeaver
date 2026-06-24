import { prisma } from '$lib/server/prisma';

export const PROJECT_ENVIRONMENT_PREPARE_CHANNEL = 'project_environment_prepare';

export type ProjectEnvironmentPrepareNotification = {
	organizationId: string;
	projectId: string;
	profileId: string;
	kind: 'event' | 'profile';
	seq?: number;
};

type NotifyDatabase = {
	$executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseProjectEnvironmentPrepareNotification(
	payload: string | null | undefined
): ProjectEnvironmentPrepareNotification | null {
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
	if (parsed.kind !== 'event' && parsed.kind !== 'profile') return null;
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
		kind: parsed.kind,
		...(parsed.seq === undefined ? {} : { seq: parsed.seq })
	};
}

export async function notifyProjectEnvironmentPrepare(
	notification: ProjectEnvironmentPrepareNotification,
	db: NotifyDatabase = prisma
): Promise<void> {
	await db.$executeRaw`SELECT pg_notify(${PROJECT_ENVIRONMENT_PREPARE_CHANNEL}, ${JSON.stringify(
		notification
	)})`;
}
