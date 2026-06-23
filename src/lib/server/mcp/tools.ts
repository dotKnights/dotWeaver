import { z } from 'zod';
import { env as privateEnv } from '$env/dynamic/private';
import {
	resolveOrgContext,
	AmbiguousTeamError,
	TeamAccessError,
	NoTeamError
} from '$lib/server/mcp/context';
import { listTeamsForUser } from '$lib/server/teams-service';
import {
	listProjectsForOrg,
	getProjectForOrg,
	importGithubProjectForOrg,
	GithubProjectImportError
} from '$lib/server/projects-service';
import {
	listRunsForOrg,
	getRunForOrg,
	getRunDiffForOrg,
	RunWorkspaceUnavailableError,
	cancelRunForOrg,
	approveRunForOrg,
	RunMutationError
} from '$lib/server/runs-service';
import { RUN_MODE, type RunMode } from '$lib/domain/run-mode';
import { startRunForOrg, RunStartError } from '$lib/server/run-start-service';
import { replyToRunForOrg, RunReplyError } from '$lib/server/run-reply-service';
import { getGithubTokenForUser } from '$lib/server/github-git';
import { ProjectAgentConfigError } from '$lib/server/project-agent-config-service';
import { importProjectSchema } from '$lib/schemas/projects';
import {
	runModelSchema,
	replyToRunSchema,
	startRunSchema,
	type RunAgent,
	type RunModel
} from '$lib/schemas/runs';

export interface McpToolContext {
	userId: string;
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
type ToolSchema = Record<string, z.ZodTypeAny>;
type ProgressToken = string | number;

interface McpToolExtra {
	_meta?: { progressToken?: ProgressToken };
	signal?: AbortSignal;
	sendNotification?: (notification: {
		method: 'notifications/progress';
		params: { progressToken: ProgressToken; progress: number; message: string };
	}) => Promise<void>;
}

interface McpServerLike {
	tool(name: string, description: string, schema: ToolSchema, handler: unknown): void;
}

const ok = (data: unknown): ToolResult => ({
	content: [{ type: 'text', text: JSON.stringify(data, null, 2) }]
});
const fail = (message: string): ToolResult => ({
	content: [{ type: 'text', text: message }],
	isError: true
});
const TIMEOUT_MS = Number(privateEnv.RUN_TIMEOUT_MS ?? 30 * 60 * 1000);

/** Mappe les erreurs de resolution d org vers des messages outil non fuitants. */
function mapOrgError(e: unknown): ToolResult | null {
	if (e instanceof AmbiguousTeamError) return fail(e.message);
	if (e instanceof TeamAccessError) return fail('Access denied to the requested team');
	if (e instanceof NoTeamError) return fail('You are not a member of any team');
	return null;
}

function mapWriteError(e: unknown): ToolResult | null {
	if (
		e instanceof GithubProjectImportError ||
		e instanceof RunStartError ||
		e instanceof RunMutationError ||
		e instanceof RunReplyError ||
		e instanceof ProjectAgentConfigError
	) {
		return fail(e.message);
	}
	return null;
}

const team = z.string().optional().describe('Team slug. Optional if you belong to a single team.');

/** Enregistre les outils MCP sur un McpServer, scopes a ctx.userId. */
export function registerTools(server: unknown, ctx: McpToolContext): void {
	const mcpServer = server as McpServerLike;

	mcpServer.tool(
		'list_teams',
		'List the teams (organizations) you belong to.',
		{},
		async (): Promise<ToolResult> => {
			try {
				return ok(await listTeamsForUser(ctx.userId));
			} catch {
				return fail('Failed to list teams');
			}
		}
	);

	mcpServer.tool(
		'list_projects',
		'List projects in a team.',
		{ team },
		async (args: { team?: string }): Promise<ToolResult> => {
			try {
				const orgId = await resolveOrgContext(ctx.userId, args.team);
				return ok(await listProjectsForOrg(orgId));
			} catch (e) {
				return mapOrgError(e) ?? fail('Failed to list projects');
			}
		}
	);

	mcpServer.tool(
		'get_project',
		'Get a project by id.',
		{ projectId: z.string(), team },
		async (args: { projectId: string; team?: string }): Promise<ToolResult> => {
			try {
				const orgId = await resolveOrgContext(ctx.userId, args.team);
				const project = await getProjectForOrg(orgId, args.projectId);
				return project ? ok(project) : fail('Project not found');
			} catch (e) {
				return mapOrgError(e) ?? fail('Failed to get project');
			}
		}
	);

	mcpServer.tool(
		'import_github_project',
		'Import a GitHub repository as a project in a team.',
		{ ...importProjectSchema.shape, team },
		async (args: { owner: string; name: string; team?: string }): Promise<ToolResult> => {
			try {
				const organizationId = await resolveOrgContext(ctx.userId, args.team);
				const token = await getGithubTokenForUser(ctx.userId);
				return ok(
					await importGithubProjectForOrg({
						organizationId,
						userId: ctx.userId,
						token,
						owner: args.owner,
						name: args.name
					})
				);
			} catch (e) {
				return mapOrgError(e) ?? mapWriteError(e) ?? fail('Failed to import GitHub project');
			}
		}
	);

	mcpServer.tool(
		'list_runs',
		'List runs of a project, most recent first.',
		{ projectId: z.string(), team },
		async (args: { projectId: string; team?: string }): Promise<ToolResult> => {
			try {
				const orgId = await resolveOrgContext(ctx.userId, args.team);
				return ok(await listRunsForOrg(orgId, args.projectId));
			} catch (e) {
				return mapOrgError(e) ?? fail('Failed to list runs');
			}
		}
	);

	mcpServer.tool(
		'start_cdc_run',
		'Start a cahier des charges run for a project. The run uses the native cahier-des-charges skill and produces a Markdown CDC draft for later validation.',
		{
			projectId: z.string(),
			prompt: z
				.string()
				.min(1)
				.describe('Initial product or project need to frame as a cahier des charges.'),
			baseBranch: z.string().optional(),
			model: runModelSchema.optional(),
			team
		},
		async (args: {
			projectId: string;
			prompt: string;
			baseBranch?: string;
			model?: RunModel;
			team?: string;
		}): Promise<ToolResult> => {
			try {
				const organizationId = await resolveOrgContext(ctx.userId, args.team);
				const run = await startRunForOrg({
					organizationId,
					userId: ctx.userId,
					projectId: args.projectId,
					prompt: args.prompt,
					baseBranch: args.baseBranch,
					model: args.model,
					mode: RUN_MODE.CDC,
					useProjectAgentConfig: true
				});
				return run ? ok(run) : fail('Project not found');
			} catch (e) {
				return mapOrgError(e) ?? mapWriteError(e) ?? fail('Failed to start CDC run');
			}
		}
	);

	mcpServer.tool(
		'start_run',
		'Start an agent run for a project.',
		{ ...startRunSchema.shape, team },
		async (args: {
			projectId: string;
			prompt: string;
			baseBranch?: string;
			agent?: RunAgent;
			model?: RunModel;
			useProjectAgentConfig?: boolean;
			mode?: RunMode;
			team?: string;
		}): Promise<ToolResult> => {
			try {
				const organizationId = await resolveOrgContext(ctx.userId, args.team);
				const result = await startRunForOrg({
					organizationId,
					userId: ctx.userId,
					projectId: args.projectId,
					prompt: args.prompt,
					agent: args.agent,
					baseBranch: args.baseBranch,
					model: args.model,
					useProjectAgentConfig: args.useProjectAgentConfig ?? true,
					mode: args.mode
				});
				return result ? ok({ runId: result.runId }) : fail('Project not found');
			} catch (e) {
				return mapOrgError(e) ?? mapWriteError(e) ?? fail('Failed to start run');
			}
		}
	);

	mcpServer.tool(
		'get_run',
		'Get a run with its ordered events.',
		{ runId: z.string(), team },
		async (args: { runId: string; team?: string }): Promise<ToolResult> => {
			try {
				const orgId = await resolveOrgContext(ctx.userId, args.team);
				const run = await getRunForOrg(orgId, args.runId);
				return run ? ok(run) : fail('Run not found');
			} catch (e) {
				return mapOrgError(e) ?? fail('Failed to get run');
			}
		}
	);

	mcpServer.tool(
		'cancel_run',
		'Cancel an active run.',
		{ runId: z.string(), team },
		async (args: { runId: string; team?: string }): Promise<ToolResult> => {
			try {
				const organizationId = await resolveOrgContext(ctx.userId, args.team);
				const result = await cancelRunForOrg(organizationId, args.runId);
				return result ? ok({ canceled: result.canceled }) : fail('Run not found');
			} catch (e) {
				return mapOrgError(e) ?? mapWriteError(e) ?? fail('Failed to cancel run');
			}
		}
	);

	mcpServer.tool(
		'reply_to_run',
		'Reply to a run awaiting review and resume it.',
		{ ...replyToRunSchema.shape, team },
		async (args: { runId: string; message: string; team?: string }): Promise<ToolResult> => {
			try {
				const organizationId = await resolveOrgContext(ctx.userId, args.team);
				const result = await replyToRunForOrg(organizationId, {
					runId: args.runId,
					message: args.message,
					timeoutAt: new Date(Date.now() + TIMEOUT_MS)
				});
				return result ? ok({ ok: true }) : fail('Run not found');
			} catch (e) {
				return mapOrgError(e) ?? mapWriteError(e) ?? fail('Failed to reply to run');
			}
		}
	);

	mcpServer.tool(
		'approve_run',
		'Approve a run by opening a pull request or abandoning it.',
		{ runId: z.string().min(1), action: z.enum(['push_pr', 'abandon']), team },
		async (args: {
			runId: string;
			action: 'push_pr' | 'abandon';
			team?: string;
		}): Promise<ToolResult> => {
			try {
				const organizationId = await resolveOrgContext(ctx.userId, args.team);
				const token = await getGithubTokenForUser(ctx.userId);
				const result = await approveRunForOrg({
					organizationId,
					githubToken: token,
					runId: args.runId,
					action: args.action
				});
				return result
					? ok({ status: result.status, pullRequestUrl: result.pullRequestUrl })
					: fail('Run not found');
			} catch (e) {
				return mapOrgError(e) ?? mapWriteError(e) ?? fail('Failed to approve run');
			}
		}
	);

	mcpServer.tool(
		'get_run_diff',
		'Get the git diff (base..head) of a run.',
		{ runId: z.string(), team },
		async (args: { runId: string; team?: string }): Promise<ToolResult> => {
			try {
				const orgId = await resolveOrgContext(ctx.userId, args.team);
				const diff = await getRunDiffForOrg(orgId, args.runId);
				return diff ? ok(diff) : fail('Run not found');
			} catch (e) {
				const mapped = mapOrgError(e);
				if (mapped) return mapped;
				if (e instanceof RunWorkspaceUnavailableError) return fail(e.message);
				return fail('Failed to compute diff');
			}
		}
	);

	mcpServer.tool(
		'stream_run_events',
		'Stream a run events until it reaches a terminal state. Progress is sent as notifications; the full event list is also returned at the end.',
		{ runId: z.string(), team },
		async (args: { runId: string; team?: string }, extra?: McpToolExtra): Promise<ToolResult> => {
			try {
				const orgId = await resolveOrgContext(ctx.userId, args.team);
				const run = await getRunForOrg(orgId, args.runId);
				if (!run) return fail('Run not found');

				const { streamRunEvents } = await import('$lib/server/run-stream');
				const progressToken = extra?._meta?.progressToken;
				const collected: { seq: number; payload: unknown }[] = [];
				let finalStatus = run.status;

				for await (const item of streamRunEvents(args.runId, { signal: extra?.signal })) {
					if (item.kind === 'event') {
						collected.push({ seq: item.seq, payload: item.payload });
						if (progressToken !== undefined && extra?.sendNotification) {
							await extra.sendNotification({
								method: 'notifications/progress',
								params: {
									progressToken,
									progress: item.seq,
									message: JSON.stringify(item.payload)
								}
							});
						}
					} else if (item.kind === 'done') {
						finalStatus = item.status;
					}
				}
				return ok({ status: finalStatus, events: collected });
			} catch (e) {
				return mapOrgError(e) ?? fail('Failed to stream run events');
			}
		}
	);
}
