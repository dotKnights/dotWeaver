import { z } from 'zod';

/** Dépôt GitHub tel qu'envoyé dans tout payload webhook. */
const githubRepoSchema = z.object({
	id: z.number(),
	full_name: z.string(),
	default_branch: z.string()
});

const githubIssueSchema = z.object({
	number: z.number(),
	title: z.string(),
	body: z.string().nullish(),
	labels: z.array(z.object({ name: z.string() })).default([]),
	html_url: z.string()
});

const githubCommentSchema = z.object({
	body: z.string(),
	html_url: z.string(),
	user: z.object({ login: z.string() })
});

const githubPullRequestSchema = z.object({
	number: z.number(),
	title: z.string(),
	body: z.string().nullish(),
	base: z.object({ ref: z.string() }),
	head: z.object({ ref: z.string() }),
	html_url: z.string()
});

const githubReviewSchema = z.object({
	state: z.string(),
	body: z.string().nullish(),
	html_url: z.string(),
	user: z.object({ login: z.string() })
});

const issuesOpenedPayloadSchema = z.object({
	issue: githubIssueSchema,
	repository: githubRepoSchema
});

const issueCommentCreatedPayloadSchema = z.object({
	issue: githubIssueSchema,
	comment: githubCommentSchema,
	repository: githubRepoSchema
});

const pullRequestReviewSubmittedPayloadSchema = z.object({
	pull_request: githubPullRequestSchema,
	review: githubReviewSchema,
	repository: githubRepoSchema
});

export type GithubRepo = z.infer<typeof githubRepoSchema>;
export type GithubIssue = z.infer<typeof githubIssueSchema>;
export type GithubComment = z.infer<typeof githubCommentSchema>;
export type GithubPullRequest = z.infer<typeof githubPullRequestSchema>;
export type GithubReview = z.infer<typeof githubReviewSchema>;

export type ParsedEvent =
	| { kind: 'issues_opened'; repo: GithubRepo; issue: GithubIssue }
	| {
			kind: 'issue_comment_created';
			repo: GithubRepo;
			issue: GithubIssue;
			comment: GithubComment;
	  }
	| {
			kind: 'pull_request_review_submitted';
			repo: GithubRepo;
			pr: GithubPullRequest;
			review: GithubReview;
	  }
	| { kind: 'unhandled'; eventName: string; action: string | null };

export type ParseEventResult =
	| { ok: true; event: ParsedEvent }
	| { ok: false; error: string };

/** Action déclarée dans le corps du payload, quand elle est présente. */
export function readPayloadAction(payload: unknown): string | null {
	if (typeof payload !== 'object' || payload === null) return null;
	const action = (payload as { action?: unknown }).action;
	return typeof action === 'string' ? action : null;
}

function unhandled(eventName: string, action: string | null): ParseEventResult {
	return { ok: true, event: { kind: 'unhandled', eventName, action } };
}

function formatZodError(error: z.ZodError): string {
	return error.issues
		.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
		.join('; ');
}

/**
 * Convertit un payload brut en évènement typé. Les évènements/actions hors périmètre v1
 * ne sont pas des erreurs : ils remontent en `unhandled` et la livraison sera `SKIPPED`.
 */
export function parseGithubEvent(eventName: string, payload: unknown): ParseEventResult {
	const action = readPayloadAction(payload);

	if (eventName === 'issues' && action === 'opened') {
		const parsed = issuesOpenedPayloadSchema.safeParse(payload);
		if (!parsed.success) return { ok: false, error: formatZodError(parsed.error) };
		return {
			ok: true,
			event: { kind: 'issues_opened', repo: parsed.data.repository, issue: parsed.data.issue }
		};
	}

	if (eventName === 'issue_comment' && action === 'created') {
		const parsed = issueCommentCreatedPayloadSchema.safeParse(payload);
		if (!parsed.success) return { ok: false, error: formatZodError(parsed.error) };
		return {
			ok: true,
			event: {
				kind: 'issue_comment_created',
				repo: parsed.data.repository,
				issue: parsed.data.issue,
				comment: parsed.data.comment
			}
		};
	}

	if (eventName === 'pull_request_review' && action === 'submitted') {
		const parsed = pullRequestReviewSubmittedPayloadSchema.safeParse(payload);
		if (!parsed.success) return { ok: false, error: formatZodError(parsed.error) };
		return {
			ok: true,
			event: {
				kind: 'pull_request_review_submitted',
				repo: parsed.data.repository,
				pr: parsed.data.pull_request,
				review: parsed.data.review
			}
		};
	}

	return unhandled(eventName, action);
}

/** Dépôt concerné par l'évènement, `null` pour un évènement non géré. */
export function eventRepo(event: ParsedEvent): GithubRepo | null {
	return event.kind === 'unhandled' ? null : event.repo;
}
