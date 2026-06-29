import type {
	ProjectEnvVar,
	ProjectMcpServer,
	ProjectSkill,
	ProjectSkillFile
} from '@prisma/client';

type RuntimeSkill = Pick<ProjectSkill, 'name' | 'body'> & {
	files: Array<Pick<ProjectSkillFile, 'path' | 'content'>>;
};
type RuntimeMcpServerSnapshot = Pick<ProjectMcpServer, 'id' | 'name' | 'transport'>;
type RuntimeSkillSnapshot = Pick<
	ProjectSkill,
	'id' | 'name' | 'sourceProvider' | 'sourceSkillId' | 'sourceHash'
>;
type RuntimeEnvVarSnapshot = Pick<ProjectEnvVar, 'key'>;

export interface RuntimeAgentConfig {
	mcpJson: { mcpServers: Record<string, Record<string, unknown>> };
	settings: { enabledMcpjsonServers: string[] };
	skills: RuntimeSkill[];
	secretEnv: Record<string, string>;
	envFile: Array<Pick<ProjectEnvVar, 'key'> & { value: string }>;
	snapshot: {
		enabled: boolean;
		mcpServers: RuntimeMcpServerSnapshot[];
		skills: RuntimeSkillSnapshot[];
		envVars: RuntimeEnvVarSnapshot[];
	};
}

export type GeneratedEnvFileEntry = Pick<ProjectEnvVar, 'key'> &
	Partial<Pick<ProjectEnvVar, 'sensitive'>> & { value: string };

export type RuntimeMcpServer = RuntimeAgentConfig['mcpJson']['mcpServers'][string];
