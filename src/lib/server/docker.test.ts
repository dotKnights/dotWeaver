import { describe, it, expect } from 'vitest';
import { buildRunArgs } from './docker';

describe('buildRunArgs', () => {
	it('includes hardening flags, the workspace mount, env pairs, image last', () => {
		const args = buildRunArgs({
			image: 'dotweaver-runner',
			name: 'run-abc',
			workspacePath: '/ws/proj/runs/abc',
			env: { RUN_PROMPT: 'do it', CLAUDE_CODE_OAUTH_TOKEN: 'tok' }
		});
		expect(args[0]).toBe('run');
		expect(args).toContain('--rm');
		expect(args).toEqual(expect.arrayContaining(['--cap-drop', 'ALL']));
		expect(args).toEqual(expect.arrayContaining(['--security-opt', 'no-new-privileges']));
		expect(args).toEqual(expect.arrayContaining(['--name', 'run-abc']));
		expect(args).toEqual(expect.arrayContaining(['-v', '/ws/proj/runs/abc:/workspace']));
		expect(args).toEqual(expect.arrayContaining(['-e', 'RUN_PROMPT=do it']));
		expect(args).toEqual(expect.arrayContaining(['-e', 'CLAUDE_CODE_OAUTH_TOKEN=tok']));
		expect(args[args.length - 1]).toBe('dotweaver-runner');
	});

	it('defaults network to bridge (MVP open egress) and applies resource limits', () => {
		const args = buildRunArgs({ image: 'img', name: 'n', workspacePath: '/w', env: {} });
		expect(args).toEqual(expect.arrayContaining(['--network', 'bridge']));
		expect(args).toEqual(expect.arrayContaining(['--memory', '4g']));
		expect(args).toEqual(expect.arrayContaining(['--cpus', '2']));
		expect(args).toEqual(expect.arrayContaining(['--pids-limit', '512']));
	});
});
