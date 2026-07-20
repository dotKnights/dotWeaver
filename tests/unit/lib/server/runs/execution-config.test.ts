import { describe, expect, it } from 'vitest';
import {
	assertProviderCredentialForwardingAllowed,
	buildRunContainerRuntimeConfig,
	runAgent
} from '$lib/server/runs/execution-config';

describe('run execution config', () => {
	it('normalizes persisted run agent values', () => {
		expect(runAgent('codex')).toBe('codex');
		expect(runAgent('claude')).toBe('claude');
		expect(runAgent(null)).toBe('claude');
		expect(runAgent('unknown')).toBe('claude');
	});

	it('builds claude runtime env with project and agent config entries', () => {
		expect(
			buildRunContainerRuntimeConfig({
				agent: 'claude',
				prompt: 'continue',
				sessionId: 'session-1',
				model: 'sonnet',
				environmentConfig: { containerEnv: [{ key: 'DATABASE_URL', value: 'postgres://db' }] },
				agentConfig: {
					envFile: [{ key: 'PUBLIC_FLAG', value: 'true' }],
					secretEnv: { API_KEY: 'secret' }
				},
				providerEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token' },
				codexAuthJson: null,
				forwardProviderCredentials: true
			})
		).toEqual({
			env: {
				DATABASE_URL: 'postgres://db',
				PUBLIC_FLAG: 'true',
				API_KEY: 'secret',
				RUN_PROMPT: 'continue',
				RUN_AGENT: 'claude',
				CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
				CLAUDE_CONFIG_DIR: '/workspace/.dotweaver/claude-config',
				RUN_MODEL: 'sonnet',
				RUN_RESUME_SESSION: 'session-1'
			},
			mounts: []
		});
	});

	it('mounts codex auth json only when provider credentials are forwarded', () => {
		expect(
			buildRunContainerRuntimeConfig({
				agent: 'codex',
				prompt: 'do it',
				environmentConfig: {},
				agentConfig: { envFile: [], secretEnv: {} },
				providerEnv: {},
				codexAuthJson: '/home/me/.codex/auth.json',
				forwardProviderCredentials: true
			})
		).toEqual({
			env: {
				RUN_PROMPT: 'do it',
				RUN_AGENT: 'codex',
				CODEX_AUTH_JSON_SOURCE: '/runner/codex-auth/auth.json'
			},
			mounts: [
				{
					source: '/home/me/.codex/auth.json',
					target: '/runner/codex-auth/auth.json',
					readOnly: true
				}
			]
		});
	});

	it('refuses to expose provider credentials unless forwarding is enabled', () => {
		expect(() =>
			assertProviderCredentialForwardingAllowed({
				agent: 'codex',
				codexAuthJson: '/home/me/.codex/auth.json',
				providerEnv: {},
				forwardProviderCredentials: false
			})
		).toThrow(/provider credential forwarding is disabled/);

		expect(() =>
			assertProviderCredentialForwardingAllowed({
				agent: 'codex',
				codexAuthJson: '/home/me/.codex/auth.json',
				providerEnv: {},
				forwardProviderCredentials: true
			})
		).not.toThrow();
	});
});
