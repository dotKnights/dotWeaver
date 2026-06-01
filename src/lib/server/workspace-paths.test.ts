import { describe, it, expect } from 'vitest';
import { workspaceRoot, mirrorPath, runWorktreePath, agentBranch, containerName } from './workspace-paths';

describe('workspace-paths', () => {
	it('uses WORKSPACE_ROOT when set, else a default', () => {
		expect(workspaceRoot({ WORKSPACE_ROOT: '/data/ws' })).toBe('/data/ws');
		expect(workspaceRoot({})).toBe('/tmp/dotweaver-workspaces');
	});

	it('derives mirror and worktree paths from ids', () => {
		expect(mirrorPath('/data/ws', 'proj1')).toBe('/data/ws/proj1/repo.git');
		expect(runWorktreePath('/data/ws', 'proj1', 'run1')).toBe('/data/ws/proj1/runs/run1');
	});

	it('names the agent branch from the run id', () => {
		expect(agentBranch('run1')).toBe('claude/run1');
	});
});

describe('containerName', () => {
	it('derives a deterministic docker container name from the run id', () => {
		expect(containerName('run1')).toBe('dwrun-run1');
	});
});
