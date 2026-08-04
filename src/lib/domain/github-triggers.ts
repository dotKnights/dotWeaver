import type { GithubTriggerEventType } from '@prisma/client';

export const GITHUB_TRIGGER_EVENT_TYPE = {
	ISSUES_OPENED: 'ISSUES_OPENED',
	ISSUE_COMMENT_CREATED: 'ISSUE_COMMENT_CREATED',
	PULL_REQUEST_REVIEW_SUBMITTED: 'PULL_REQUEST_REVIEW_SUBMITTED'
} as const satisfies Record<string, GithubTriggerEventType>;

/** Libellés affichés dans le formulaire de trigger. */
export const GITHUB_TRIGGER_EVENTS = [
	{
		value: GITHUB_TRIGGER_EVENT_TYPE.ISSUES_OPENED,
		label: 'Issue opened',
		description: 'Fires when an issue carrying the configured label is opened.'
	},
	{
		value: GITHUB_TRIGGER_EVENT_TYPE.ISSUE_COMMENT_CREATED,
		label: 'Issue comment created',
		description: 'Fires when a comment is added to an issue carrying the configured label.'
	},
	{
		value: GITHUB_TRIGGER_EVENT_TYPE.PULL_REQUEST_REVIEW_SUBMITTED,
		label: 'PR review submitted',
		description: 'Fires when a review requesting changes is submitted on a pull request.'
	}
] as const satisfies ReadonlyArray<{
	value: GithubTriggerEventType;
	label: string;
	description: string;
}>;

/** Placeholder résolu vers la branche par défaut du dépôt (voir §5 de la spec). */
export const DEFAULT_BRANCH_PLACEHOLDER = '{{default_branch}}';

/** Longueur max d'une valeur substituée : limite la surface d'injection de prompt (§7.5). */
export const TEMPLATE_VALUE_MAX_LENGTH = 8_000;

export type TemplateVariable = {
	name: string;
	description: string;
};

const COMMON_VARIABLES: readonly TemplateVariable[] = [
	{ name: 'default_branch', description: "Repository's default branch" },
	{ name: 'repo.full_name', description: '`owner/repo` string' }
];

const ISSUE_VARIABLES: readonly TemplateVariable[] = [
	{ name: 'issue.title', description: 'Issue title' },
	{ name: 'issue.body', description: 'Issue body (Markdown)' },
	{ name: 'issue.number', description: 'Issue number' },
	{ name: 'issue.url', description: 'GitHub issue URL' }
];

/** Variables disponibles par type d'évènement (source de vérité UI + validation). */
export const TEMPLATE_VARIABLES_BY_EVENT: Record<
	GithubTriggerEventType,
	readonly TemplateVariable[]
> = {
	ISSUES_OPENED: [...ISSUE_VARIABLES, ...COMMON_VARIABLES],
	ISSUE_COMMENT_CREATED: [
		...ISSUE_VARIABLES,
		{ name: 'comment.body', description: 'Comment text' },
		{ name: 'comment.author', description: 'Comment author login' },
		...COMMON_VARIABLES
	],
	PULL_REQUEST_REVIEW_SUBMITTED: [
		{ name: 'pr.title', description: 'PR title' },
		{ name: 'pr.body', description: 'PR description' },
		{ name: 'pr.number', description: 'PR number' },
		{ name: 'pr.url', description: 'GitHub PR URL' },
		{ name: 'pr.base_branch', description: 'PR base branch ref' },
		{ name: 'pr.head_branch', description: 'PR head branch ref' },
		{ name: 'review.body', description: 'Review comment body' },
		{ name: 'review.author', description: 'Reviewer login' },
		...COMMON_VARIABLES
	]
};

const ALLOWED_VARS_BY_EVENT: Record<GithubTriggerEventType, ReadonlySet<string>> = {
	ISSUES_OPENED: new Set(TEMPLATE_VARIABLES_BY_EVENT.ISSUES_OPENED.map((v) => v.name)),
	ISSUE_COMMENT_CREATED: new Set(
		TEMPLATE_VARIABLES_BY_EVENT.ISSUE_COMMENT_CREATED.map((v) => v.name)
	),
	PULL_REQUEST_REVIEW_SUBMITTED: new Set(
		TEMPLATE_VARIABLES_BY_EVENT.PULL_REQUEST_REVIEW_SUBMITTED.map((v) => v.name)
	)
};

/** Valeurs d'exemple utilisées par l'aperçu live du formulaire de trigger. */
export const EXAMPLE_TEMPLATE_VARS: Record<string, string> = {
	default_branch: 'main',
	'repo.full_name': 'acme/web-app',
	'issue.title': 'Login button is unresponsive on Safari',
	'issue.body': 'Clicking "Sign in" does nothing on Safari 17.',
	'issue.number': '482',
	'issue.url': 'https://github.com/acme/web-app/issues/482',
	'comment.body': '/ai-fix please take a look',
	'comment.author': 'alice',
	'pr.title': 'Add retry to the upload queue',
	'pr.body': 'Retries failed uploads up to three times.',
	'pr.number': '917',
	'pr.url': 'https://github.com/acme/web-app/pull/917',
	'pr.base_branch': 'main',
	'pr.head_branch': 'feat/upload-retry',
	'review.body': 'Please extract the retry loop into its own function.',
	'review.author': 'bob'
};

const TEMPLATE_VARIABLE_PATTERN = /\{\{([^}]+)\}\}/g;

/** Noms de variables référencés par un template, dans l'ordre d'apparition. */
export function extractTemplateVariables(template: string): string[] {
	return [...template.matchAll(TEMPLATE_VARIABLE_PATTERN)].map((match) => match[1].trim());
}

/**
 * Renvoie les variables non disponibles pour ce type d'évènement.
 * Un tableau vide signifie que le template est valide.
 */
export function validatePromptTemplate(
	template: string,
	eventType: GithubTriggerEventType
): string[] {
	const allowed = ALLOWED_VARS_BY_EVENT[eventType];
	const seen = new Set<string>();
	return extractTemplateVariables(template).filter((name) => {
		if (allowed.has(name) || seen.has(name)) return false;
		seen.add(name);
		return true;
	});
}

/** Tronque une valeur substituée pour borner la taille du prompt final (§7.5). */
export function truncateTemplateValue(
	value: string,
	maxLength: number = TEMPLATE_VALUE_MAX_LENGTH
): string {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, maxLength)}… [truncated]`;
}

/**
 * Substitue les `{{variable}}` par leur valeur. Une variable inconnue ou indisponible
 * pour l'évènement courant est remplacée par une chaîne vide (jamais laissée telle quelle,
 * pour éviter qu'un placeholder brut n'atteigne l'agent).
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
	return template.replace(TEMPLATE_VARIABLE_PATTERN, (_match, key: string) => {
		const value = vars[key.trim()];
		return value === undefined ? '' : truncateTemplateValue(value);
	});
}

/** `{{default_branch}}` est le seul placeholder accepté dans la branche de base d'un run. */
export function resolveBaseBranch(runBaseBranch: string, defaultBranch: string): string {
	const resolved = runBaseBranch.split(DEFAULT_BRANCH_PLACEHOLDER).join(defaultBranch).trim();
	return resolved || defaultBranch;
}

function globToRegExp(pattern: string): RegExp {
	let source = '^';
	for (let index = 0; index < pattern.length; index += 1) {
		const char = pattern[index];
		if (char === '*') {
			source += '[^/]*';
			continue;
		}
		if (char === '?') {
			source += '[^/]';
			continue;
		}
		if (char === '[') {
			const close = pattern.indexOf(']', index + 1);
			// Un `[` non fermé est traité comme un littéral plutôt que comme une classe.
			if (close === -1) {
				source += '\\[';
				continue;
			}
			const body = pattern.slice(index + 1, close).replace(/\\/g, '\\\\');
			source += `[${body.startsWith('!') ? `^${body.slice(1)}` : body}]`;
			index = close;
			continue;
		}
		source += char.replace(/[.+^${}()|\\]/g, '\\$&');
	}
	return new RegExp(`${source}$`);
}

/**
 * Glob simple sur un nom de branche : `main`, `release/*`, `v[0-9]*`.
 * `*` et `?` ne traversent pas les `/`, comme dans les globs de chemins.
 */
export function matchesGlob(value: string, pattern: string): boolean {
	if (!pattern) return true;
	return globToRegExp(pattern).test(value);
}
