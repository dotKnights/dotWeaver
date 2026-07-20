import type { RunAgent } from '$lib/schemas/runs';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONTAINER_CODEX_AUTH_JSON = '/runner/codex-auth/auth.json';
const CONTAINER_CLAUDE_CONFIG_DIR = '/workspace/.dotweaver/claude-config';
const PROVIDER_CREDENTIAL_FORWARDING_FLAG = 'DOTWEAVER_ALLOW_UNTRUSTED_AGENT_PROVIDER_CREDENTIALS';

type EnvEntry = { key: string; value: string };
type ProviderEnv = Record<string, string | undefined>;
type RuntimeMount = { source: string; target: string; readOnly?: boolean };

type RunContainerRuntimeConfigInput = {
	agent: RunAgent;
	prompt: string;
	sessionId?: string | null;
	model?: string | null;
	environmentConfig: unknown;
	agentConfig: {
		envFile?: EnvEntry[];
		secretEnv?: Record<string, string>;
	};
	providerEnv: ProviderEnv;
	codexAuthJson: string | null;
	forwardProviderCredentials: boolean;
};

export function runAgent(value: string | null | undefined): RunAgent {
	return value === 'codex' ? 'codex' : 'claude';
}

export function localCodexAuthJsonPath(providerEnv: ProviderEnv): string | null {
	const configured = providerEnv.CODEX_AUTH_JSON_PATH;
	if (configured && existsSync(configured)) return configured;
	const defaultPath = join(homedir(), '.codex', 'auth.json');
	return existsSync(defaultPath) ? defaultPath : null;
}

export function providerCredentialForwardingAllowed(providerEnv: ProviderEnv): boolean {
	return providerEnv[PROVIDER_CREDENTIAL_FORWARDING_FLAG] === 'true';
}

function sharedProviderCredentialSources(input: {
	agent: RunAgent;
	codexAuthJson: string | null;
	providerEnv: ProviderEnv;
}): string[] {
	if (input.agent === 'claude') {
		return input.providerEnv.CLAUDE_CODE_OAUTH_TOKEN ? ['CLAUDE_CODE_OAUTH_TOKEN'] : [];
	}

	const sources: string[] = [];
	if (input.providerEnv.CODEX_API_KEY) sources.push('CODEX_API_KEY');
	if (input.providerEnv.CODEX_ACCESS_TOKEN) sources.push('CODEX_ACCESS_TOKEN');
	if (
		!input.providerEnv.CODEX_API_KEY &&
		!input.providerEnv.CODEX_ACCESS_TOKEN &&
		input.codexAuthJson
	) {
		sources.push('Codex auth cache');
	}
	return sources;
}

export function assertProviderCredentialForwardingAllowed(input: {
	agent: RunAgent;
	codexAuthJson: string | null;
	providerEnv: ProviderEnv;
	forwardProviderCredentials: boolean;
}): void {
	const sources = sharedProviderCredentialSources(input);
	if (sources.length === 0 || input.forwardProviderCredentials) return;
	throw new Error(
		`Agent provider credential forwarding is disabled by default; refusing to expose ${sources.join(
			', '
		)} to the repository-controlled ${input.agent} container. Set ${PROVIDER_CREDENTIAL_FORWARDING_FLAG}=true only for trusted repositories.`
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function envEntriesToRecord(entries: EnvEntry[] = []): Record<string, string> {
	return Object.fromEntries(entries.map((entry) => [entry.key, entry.value]));
}

function containerEnvEntries(input: unknown): EnvEntry[] {
	if (!isRecord(input)) return [];
	const entries = input.containerEnv;
	if (!Array.isArray(entries)) return [];
	return entries.filter(
		(entry): entry is EnvEntry =>
			isRecord(entry) && typeof entry.key === 'string' && typeof entry.value === 'string'
	);
}

export function buildRunContainerRuntimeConfig(input: RunContainerRuntimeConfigInput): {
	env: Record<string, string>;
	mounts: RuntimeMount[];
} {
	const projectRuntimeEnv = envEntriesToRecord([
		...containerEnvEntries(input.environmentConfig),
		...(input.agentConfig.envFile ?? [])
	]);
	const env: Record<string, string> = {
		...projectRuntimeEnv,
		...(input.agentConfig.secretEnv ?? {}),
		RUN_PROMPT: input.prompt,
		RUN_AGENT: input.agent
	};
	const mounts: RuntimeMount[] = [];

	if (input.agent === 'claude') {
		if (input.forwardProviderCredentials && input.providerEnv.CLAUDE_CODE_OAUTH_TOKEN) {
			env.CLAUDE_CODE_OAUTH_TOKEN = input.providerEnv.CLAUDE_CODE_OAUTH_TOKEN;
		}
		env.CLAUDE_CONFIG_DIR = CONTAINER_CLAUDE_CONFIG_DIR;
	} else if (input.forwardProviderCredentials) {
		if (input.providerEnv.CODEX_API_KEY) env.CODEX_API_KEY = input.providerEnv.CODEX_API_KEY;
		if (input.providerEnv.CODEX_ACCESS_TOKEN) {
			env.CODEX_ACCESS_TOKEN = input.providerEnv.CODEX_ACCESS_TOKEN;
		}
		if (!env.CODEX_API_KEY && !env.CODEX_ACCESS_TOKEN && input.codexAuthJson) {
			env.CODEX_AUTH_JSON_SOURCE = CONTAINER_CODEX_AUTH_JSON;
			mounts.push({
				source: input.codexAuthJson,
				target: CONTAINER_CODEX_AUTH_JSON,
				readOnly: true
			});
		}
	}

	if (input.model) env.RUN_MODEL = input.model;
	if (input.sessionId) env.RUN_RESUME_SESSION = input.sessionId;

	return { env, mounts };
}
