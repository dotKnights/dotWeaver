import { agentConfigNameSchema } from '$lib/schemas/project-agent-config';
import { ProjectAgentConfigError } from '$lib/server/project-agent-config/errors';

export function assertSafeName(name: string): void {
	if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
		throw new ProjectAgentConfigError(`Invalid agent config name: ${name}`);
	}
	const result = agentConfigNameSchema.safeParse(name);
	if (!result.success) {
		throw new ProjectAgentConfigError(`Invalid agent config name: ${name}`);
	}
}

export function assertSafeSkillFilePath(path: string): void {
	if (
		path.length === 0 ||
		path.length > 240 ||
		path.startsWith('/') ||
		path.includes('\\') ||
		path.includes('\0')
	) {
		throw new ProjectAgentConfigError(`Unsafe skill file path: ${path}`);
	}
	const segments = path.split('/');
	if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
		throw new ProjectAgentConfigError(`Unsafe skill file path: ${path}`);
	}
}
