import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
	workspaceRoot,
	mirrorPath,
	runWorktreePath,
	agentBranch,
	containerName,
	projectEnvironmentPrepareCheckoutPath,
	projectEnvironmentCachePath,
	projectEnvironmentTemplatePath,
	projectEnvironmentMetadataPath
} from '$lib/server/projects/workspace-paths';

describe('workspace-paths', () => {
	it('uses WORKSPACE_ROOT when set, else a default', () => {
		expect(workspaceRoot({ WORKSPACE_ROOT: '/data/ws' })).toBe('/data/ws');
		expect(workspaceRoot({})).toBe(join(homedir(), '.dotweaver', 'workspaces'));
	});

	it('derives mirror and worktree paths from ids', () => {
		expect(mirrorPath('/data/ws', 'proj1')).toBe('/data/ws/proj1/repo.git');
		expect(runWorktreePath('/data/ws', 'proj1', 'run1')).toBe('/data/ws/proj1/runs/run1');
	});

	it('names the agent branch from the run id', () => {
		expect(agentBranch('run1')).toBe('claude/run1');
		expect(agentBranch('run1', 'claude')).toBe('claude/run1');
		expect(agentBranch('run1', 'codex')).toBe('codex/run1');
	});

	it('derives project environment prepare, template, metadata and cache paths', () => {
		expect(projectEnvironmentPrepareCheckoutPath('/root', 'p1', 'default')).toBe(
			'/root/p1/environment/default/checkout'
		);
		expect(projectEnvironmentTemplatePath('/root', 'p1', 'default')).toBe(
			'/root/p1/environment/default/template'
		);
		expect(projectEnvironmentMetadataPath('/root', 'p1', 'default')).toBe(
			'/root/p1/environment/default/metadata.json'
		);
		expect(projectEnvironmentCachePath('/root', 'p1')).toBe('/root/p1/cache');
	});
});

describe('containerName', () => {
	it('derives a deterministic docker container name from the run id', () => {
		expect(containerName('run1')).toBe('dwrun-run1');
	});
});
