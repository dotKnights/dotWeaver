import type { ProjectEnvVar, ProjectMcpServer, ProjectSecret, ProjectSkill } from '@prisma/client';

export type AgentConfig = {
	mcpServers: Array<Pick<ProjectMcpServer, 'id' | 'name' | 'transport' | 'enabled'>>;
	skills: Array<
		Pick<
			ProjectSkill,
			'id' | 'name' | 'description' | 'enabled' | 'sourceProvider' | 'sourceSkillId' | 'sourceHash'
		>
	>;
	secrets: Array<Pick<ProjectSecret, 'id' | 'name'> & { hasValue: boolean }>;
	envVars: Array<
		Pick<ProjectEnvVar, 'id' | 'key' | 'enabled' | 'sensitive'> & { value: string | null }
	>;
};

export type AgentConfigSection = 'mcp' | 'skills' | 'secrets' | 'env';
export type RevealedEnvVars = Record<string, string>;

export function skillSourceLabel(
	skill: Pick<AgentConfig['skills'][number], 'sourceProvider' | 'description'>
): string {
	return skill.sourceProvider === 'skills.sh' ? 'skills.sh' : skill.description;
}

export function envVarDisplayValue(
	envVar: Pick<AgentConfig['envVars'][number], 'id' | 'value' | 'sensitive' | 'enabled'>,
	revealedEnvVars: RevealedEnvVars
): string {
	const value = envVar.sensitive ? (revealedEnvVars[envVar.id] ?? '••••••') : (envVar.value ?? '');
	return `${value}${envVar.enabled ? '' : ' · disabled'}`;
}
