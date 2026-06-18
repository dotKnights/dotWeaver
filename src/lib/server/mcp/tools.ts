import { z } from 'zod';
import {
	resolveOrgContext,
	AmbiguousTeamError,
	TeamAccessError,
	NoTeamError
} from '$lib/server/mcp/context';
import { listTeamsForUser } from '$lib/server/teams-service';
import { listProjectsForOrg, getProjectForOrg } from '$lib/server/projects-service';
import {
	listRunsForOrg,
	getRunForOrg,
	getRunDiffForOrg,
	RunWorkspaceUnavailableError
} from '$lib/server/runs-service';
import { RUN_MODE } from '$lib/domain/run-mode';
import { startRunForOrg, RunStartError } from '$lib/server/run-start-service';
import { runModelSchema, type RunModel } from '$lib/schemas/runs';

export interface McpToolContext {
	userId: string;
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const ok = (data: unknown): ToolResult => ({
	content: [{ type: 'text', text: JSON.stringify(data, null, 2) }]
});
const fail = (message: string): ToolResult => ({
	content: [{ type: 'text', text: message }],
	isError: true
});

/** Mappe les erreurs de resolution d org vers des messages outil non fuitants. */
function mapOrgError(e: unknown): ToolResult | null {
	if (e instanceof AmbiguousTeamError) return fail(e.message);
	if (e instanceof TeamAccessError) return fail('Access denied to the requested team');
	if (e instanceof NoTeamError) return fail('You are not a member of any team');
	return null;
}

const team = z.string().optional().describe('Team slug. Optional if you belong to a single team.');

/** Enregistre les 7 outils read-only sur un McpServer, scopes a ctx.userId. */
export function registerTools(server: any, ctx: McpToolContext): void {
	server.tool(
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

	server.tool(
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

	server.tool(
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

	server.tool(
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

	server.tool(
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
				const orgId = await resolveOrgContext(ctx.userId, args.team);
				const run = await startRunForOrg({
					organizationId: orgId,
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
				const mapped = mapOrgError(e);
				if (mapped) return mapped;
				if (e instanceof RunStartError) return fail(e.message);
				return fail('Failed to start CDC run');
			}
		}
	);

	server.tool(
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

	server.tool(
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

	server.tool(
		'stream_run_events',
		'Stream a run events until it reaches a terminal state. Progress is sent as notifications; the full event list is also returned at the end.',
		{ runId: z.string(), team },
		async (args: { runId: string; team?: string }, extra: any): Promise<ToolResult> => {
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
