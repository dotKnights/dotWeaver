import type { GithubTrigger, GithubTriggerEventType } from '@prisma/client';
import { DEFAULT_BRANCH_PLACEHOLDER } from '$lib/domain/github-triggers';
import { CLAUDE_RUN_MODELS } from '$lib/schemas/runs';

/** État plat du formulaire : aplati puis re-discriminé au submit. */
export type TriggerFormValues = {
	name: string;
	description: string;
	enabled: boolean;
	eventType: GithubTriggerEventType;
	labelFilter: string;
	commentKeyword: string;
	baseBranchPattern: string;
	agent: 'claude' | 'codex';
	model: string;
	runBaseBranch: string;
	promptTemplate: string;
};

const DEFAULT_PROMPT_TEMPLATE = `Fix the following GitHub issue in this repository.

<issue_title>{{issue.title}}</issue_title>
<issue_body>{{issue.body}}</issue_body>

Reference: {{issue.url}}`;

export function emptyTriggerFormValues(): TriggerFormValues {
	return {
		name: '',
		description: '',
		enabled: true,
		eventType: 'ISSUES_OPENED',
		labelFilter: '',
		commentKeyword: '',
		baseBranchPattern: '',
		agent: 'claude',
		model: CLAUDE_RUN_MODELS[0].value,
		runBaseBranch: DEFAULT_BRANCH_PLACEHOLDER,
		promptTemplate: DEFAULT_PROMPT_TEMPLATE
	};
}

export function triggerToFormValues(trigger: GithubTrigger): TriggerFormValues {
	return {
		name: trigger.name,
		description: trigger.description ?? '',
		enabled: trigger.enabled,
		eventType: trigger.eventType,
		labelFilter: trigger.labelFilter ?? '',
		commentKeyword: trigger.commentKeyword ?? '',
		baseBranchPattern: trigger.baseBranchPattern ?? '',
		agent: trigger.agent === 'codex' ? 'codex' : 'claude',
		model: trigger.model,
		runBaseBranch: trigger.runBaseBranch,
		promptTemplate: trigger.promptTemplate
	};
}

/** Résumé d'une ligne de la liste : « Issue opened with label "ai-fix" ». */
export function describeTriggerConditions(trigger: GithubTrigger): string {
	switch (trigger.eventType) {
		case 'ISSUES_OPENED':
			return `Issue opened with label "${trigger.labelFilter ?? ''}"`;
		case 'ISSUE_COMMENT_CREATED':
			return trigger.commentKeyword
				? `Comment containing "${trigger.commentKeyword}" on an issue labelled "${trigger.labelFilter ?? ''}"`
				: `Comment on an issue labelled "${trigger.labelFilter ?? ''}"`;
		case 'PULL_REQUEST_REVIEW_SUBMITTED':
			return trigger.baseBranchPattern
				? `Review requesting changes on a PR targeting "${trigger.baseBranchPattern}"`
				: 'Review requesting changes on any pull request';
		default:
			return '';
	}
}
