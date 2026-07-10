import { z } from 'zod';
import { env as privateEnv } from '$env/dynamic/private';
import {
	resolveOrgContext,
	resolveMcpActor,
	AmbiguousTeamError,
	TeamAccessError,
	NoTeamError
} from '$lib/server/mcp/context';
import { listTeamsForUser } from '$lib/server/teams/service';
import {
	getProjectForActor,
	importGithubProjectForOrg,
	GithubProjectImportError
} from '$lib/server/projects/service';
import { listAccessibleProjects, requireProjectPermission } from '$lib/server/authz/service';
import { requireRunPermission } from '$lib/server/authz/runs';
import {
	listRunsForOrg,
	getRunForOrg,
	getRunDiffForOrg,
	RunWorkspaceUnavailableError,
	startRunForOrg,
	cancelRunForOrg,
	approveRunForOrg,
	RunMutationError
} from '$lib/server/runs/service';
import { replyToRunForOrg, RunReplyError } from '$lib/server/runs/reply-service';
import {
	answerPendingRunQuestionTextForOrg,
	RunInteractionAnswerError
} from '$lib/server/runs/interactions-service';
import { getGithubTokenForUser } from '$lib/server/integrations/github/git-auth';
import { ProjectAgentConfigError } from '$lib/server/project-agent-config/service';
import { importProjectSchema } from '$lib/schemas/projects';
import { startRunSchema, replyToRunSchema } from '$lib/schemas/runs';

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

function mapAuthzError(e: unknown, notFoundMessage = 'Resource not found'): ToolResult | null {
	if (e instanceof Error && 'status' in e && typeof e.status === 'number') {
		if (e.status === 404) return fail(notFoundMessage);
		if (e.status === 403) return fail('Forbidden');
		if (e.status === 401) return fail('Not authenticated');
		return fail(e.message || 'Request failed');
	}
	return null;
}

function mapWriteError(e: unknown): ToolResult | null {
	if (
		e instanceof GithubProjectImportError ||
		e instanceof RunMutationError ||
		e instanceof RunReplyError ||
		e instanceof RunInteractionAnswerError ||
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
		'List projects you can access.',
		{ team },
		async (args: { team?: string }): Promise<ToolResult> => {
			void args;
			try {
				const actor = await resolveMcpActor(ctx.userId);
				return ok(await listAccessibleProjects(actor));
			} catch (e) {
				return mapAuthzError(e) ?? fail('Failed to list projects');
			}
		}
	);

	mcpServer.tool(
		'get_project',
		'Get a project by id.',
		{ projectId: z.string(), team },
		async (args: { projectId: string; team?: string }): Promise<ToolResult> => {
			void args.team;
			try {
				const actor = await resolveMcpActor(ctx.userId);
				const project = await getProjectForActor(actor, args.projectId);
				return project ? ok(project) : fail('Project not found');
			} catch (e) {
				return mapAuthzError(e, 'Project not found') ?? fail('Failed to get project');
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
			void args.team;
			try {
				const actor = await resolveMcpActor(ctx.userId);
				const { organizationId } = await requireProjectPermission(
					actor,
					'run.view',
					args.projectId
				);
				return ok(await listRunsForOrg(organizationId, args.projectId));
			} catch (e) {
				return mapAuthzError(e, 'Project not found') ?? fail('Failed to list runs');
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
			model?: 'sonnet' | 'opus' | 'haiku';
			useProjectAgentConfig?: boolean;
			team?: string;
		}): Promise<ToolResult> => {
			try {
				const actor = await resolveMcpActor(ctx.userId);
				const { organizationId } = await requireProjectPermission(
					actor,
					'run.create',
					args.projectId
				);
				const token = await getGithubTokenForUser(ctx.userId);
				const result = await startRunForOrg({
					organizationId,
					userId: ctx.userId,
					githubToken: token,
					projectId: args.projectId,
					prompt: args.prompt,
					baseBranch: args.baseBranch,
					model: args.model,
					useProjectAgentConfig: args.useProjectAgentConfig ?? true,
					timeoutAt: new Date(Date.now() + TIMEOUT_MS)
				});
				return result ? ok({ runId: result.runId }) : fail('Project not found');
			} catch (e) {
				return (
					mapAuthzError(e, 'Project not found') ?? mapWriteError(e) ?? fail('Failed to start run')
				);
			}
		}
	);

	mcpServer.tool(
		'get_run',
		'Get a run with its ordered events.',
		{ runId: z.string(), team },
		async (args: { runId: string; team?: string }): Promise<ToolResult> => {
			void args.team;
			try {
				const actor = await resolveMcpActor(ctx.userId);
				const { organizationId } = await requireRunPermission(actor, 'run.view', args.runId);
				const run = await getRunForOrg(organizationId, args.runId);
				return run ? ok(run) : fail('Run not found');
			} catch (e) {
				return mapAuthzError(e, 'Run not found') ?? fail('Failed to get run');
			}
		}
	);

	mcpServer.tool(
		'cancel_run',
		'Cancel an active run.',
		{ runId: z.string(), team },
		async (args: { runId: string; team?: string }): Promise<ToolResult> => {
			void args.team;
			try {
				const actor = await resolveMcpActor(ctx.userId);
				const { organizationId } = await requireRunPermission(actor, 'run.reply', args.runId);
				const result = await cancelRunForOrg(organizationId, args.runId);
				return result ? ok({ canceled: result.canceled }) : fail('Run not found');
			} catch (e) {
				return (
					mapAuthzError(e, 'Run not found') ?? mapWriteError(e) ?? fail('Failed to cancel run')
				);
			}
		}
	);

	mcpServer.tool(
		'answer_pending_question',
		'Answer the current pending user question for a run using a natural-language message.',
		{ runId: z.string().min(1), message: z.string().trim().min(1), team },
		async (args: { runId: string; message: string; team?: string }): Promise<ToolResult> => {
			void args.team;
			try {
				const actor = await resolveMcpActor(ctx.userId);
				const { organizationId } = await requireRunPermission(actor, 'run.reply', args.runId);
				const result = await answerPendingRunQuestionTextForOrg(organizationId, {
					runId: args.runId,
					message: args.message
				});
				return result ? ok({ answered: true }) : fail('Run not found');
			} catch (e) {
				return (
					mapAuthzError(e, 'Run not found') ??
					mapWriteError(e) ??
					fail('Failed to answer pending question')
				);
			}
		}
	);

	mcpServer.tool(
		'reply_to_run',
		'Reply to a run awaiting review and resume it.',
		{ ...replyToRunSchema.shape, team },
		async (args: { runId: string; message: string; team?: string }): Promise<ToolResult> => {
			void args.team;
			try {
				const actor = await resolveMcpActor(ctx.userId);
				const { organizationId } = await requireRunPermission(actor, 'run.reply', args.runId);
				const result = await replyToRunForOrg(organizationId, {
					runId: args.runId,
					message: args.message,
					timeoutAt: new Date(Date.now() + TIMEOUT_MS)
				});
				return result ? ok({ ok: true }) : fail('Run not found');
			} catch (e) {
				return (
					mapAuthzError(e, 'Run not found') ?? mapWriteError(e) ?? fail('Failed to reply to run')
				);
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
				const actor = await resolveMcpActor(ctx.userId);
				const { organizationId } = await requireRunPermission(actor, 'run.approve', args.runId);
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
				return (
					mapAuthzError(e, 'Run not found') ?? mapWriteError(e) ?? fail('Failed to approve run')
				);
			}
		}
	);

	mcpServer.tool(
		'get_run_diff',
		'Get the git diff (base..head) of a run.',
		{ runId: z.string(), team },
		async (args: { runId: string; team?: string }): Promise<ToolResult> => {
			void args.team;
			try {
				const actor = await resolveMcpActor(ctx.userId);
				const { organizationId } = await requireRunPermission(actor, 'run.diff.view', args.runId);
				const diff = await getRunDiffForOrg(organizationId, args.runId);
				return diff ? ok(diff) : fail('Run not found');
			} catch (e) {
				const mapped = mapAuthzError(e, 'Run not found');
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
			void args.team;
			try {
				const actor = await resolveMcpActor(ctx.userId);
				const { organizationId } = await requireRunPermission(actor, 'run.view', args.runId);
				const run = await getRunForOrg(organizationId, args.runId);
				if (!run) return fail('Run not found');

				const { streamRunEvents } = await import('$lib/server/runs/stream');
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
				return mapAuthzError(e, 'Run not found') ?? fail('Failed to stream run events');
			}
		}
	);
}
