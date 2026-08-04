import type { GithubTrigger } from '@prisma/client';
import { matchesGlob, renderTemplate } from '$lib/domain/github-triggers';
import type { ParsedEvent } from '$lib/server/github-triggers/events';

/** État de review GitHub qui déclenche un trigger PR (v1 : uniquement celui-ci). */
const CHANGES_REQUESTED = 'changes_requested';

function hasLabel(labels: Array<{ name: string }>, labelFilter: string | null): boolean {
	if (!labelFilter) return false;
	const expected = labelFilter.toLowerCase();
	return labels.some((label) => label.name.toLowerCase() === expected);
}

/** Vrai si l'évènement satisfait toutes les conditions du trigger. */
export function matchesTrigger(trigger: GithubTrigger, event: ParsedEvent): boolean {
	switch (trigger.eventType) {
		case 'ISSUES_OPENED':
			return event.kind === 'issues_opened' && hasLabel(event.issue.labels, trigger.labelFilter);

		case 'ISSUE_COMMENT_CREATED': {
			if (event.kind !== 'issue_comment_created') return false;
			if (!hasLabel(event.issue.labels, trigger.labelFilter)) return false;
			if (!trigger.commentKeyword) return true;
			return event.comment.body.toLowerCase().includes(trigger.commentKeyword.toLowerCase());
		}

		case 'PULL_REQUEST_REVIEW_SUBMITTED': {
			if (event.kind !== 'pull_request_review_submitted') return false;
			if (event.review.state.toLowerCase() !== CHANGES_REQUESTED) return false;
			if (!trigger.baseBranchPattern) return true;
			return matchesGlob(event.pr.base.ref, trigger.baseBranchPattern);
		}

		default:
			return false;
	}
}

/** Variables de template disponibles pour l'évènement (voir §5.1 de la spec). */
export function buildTemplateVars(event: ParsedEvent): Record<string, string> {
	if (event.kind === 'unhandled') return {};

	const base: Record<string, string> = {
		default_branch: event.repo.default_branch,
		'repo.full_name': event.repo.full_name
	};

	if (event.kind === 'issues_opened' || event.kind === 'issue_comment_created') {
		const issueVars: Record<string, string> = {
			...base,
			'issue.title': event.issue.title,
			'issue.body': event.issue.body ?? '',
			'issue.number': String(event.issue.number),
			'issue.url': event.issue.html_url
		};
		if (event.kind === 'issues_opened') return issueVars;
		return {
			...issueVars,
			'comment.body': event.comment.body,
			'comment.author': event.comment.user.login
		};
	}

	return {
		...base,
		'pr.title': event.pr.title,
		'pr.body': event.pr.body ?? '',
		'pr.number': String(event.pr.number),
		'pr.url': event.pr.html_url,
		'pr.base_branch': event.pr.base.ref,
		'pr.head_branch': event.pr.head.ref,
		'review.body': event.review.body ?? '',
		'review.author': event.review.user.login
	};
}

/** Rend le prompt final d'un run déclenché ; les valeurs substituées sont tronquées. */
export function renderPromptTemplate(template: string, event: ParsedEvent): string {
	return renderTemplate(template, buildTemplateVars(event));
}
