import { z } from 'zod';

const NAME_RE = /^[A-Za-z0-9_-]+$/;
const SENSITIVE_KEY_RE = /(authorization|token|api[-_]?key|secret|password)/i;
const FRONTMATTER_RE = /^---\n[\s\S]*\n---(?:\n|$)/;
const RESERVED_NAMES = new Set(['dotweaver']);

export const agentConfigNameSchema = z
	.string()
	.min(1)
	.max(80)
	.regex(NAME_RE, 'Use only letters, numbers, underscores and dashes')
	.refine((name) => !RESERVED_NAMES.has(name), 'This name is reserved');

export function isSensitiveConfigKey(key: string): boolean {
	return SENSITIVE_KEY_RE.test(key);
}

export const mcpSecretRefSchema = z.object({
	secretName: agentConfigNameSchema
});
export const mcpHeaderSecretRefSchema = mcpSecretRefSchema.extend({
	prefix: z.string().optional(),
	suffix: z.string().optional()
});
export const mcpHeaderValueSchema = z.union([z.string(), mcpHeaderSecretRefSchema]);

function hasHttpProtocol(url: string): boolean {
	try {
		const protocol = new URL(url).protocol;
		return protocol === 'http:' || protocol === 'https:';
	} catch {
		return false;
	}
}

function containsControlCharacter(value: string): boolean {
	for (const char of value) {
		const code = char.charCodeAt(0);
		if (code <= 31 || code === 127) return true;
	}
	return false;
}

const httpUrlSchema = z.string().url().refine(hasHttpProtocol, {
	message: 'Use an http or https URL'
});

export const skillDescriptionSchema = z
	.string()
	.min(1)
	.max(300)
	.refine((description) => !containsControlCharacter(description), {
		message: 'Description cannot contain newline or control characters'
	});

const headersSchema = z.record(z.string().min(1), mcpHeaderValueSchema).default({});
const envRefsSchema = z.record(z.string().min(1), mcpSecretRefSchema).default({});

const baseMcpSchema = z.object({
	id: z.string().min(1).optional(),
	projectId: z.string().min(1),
	name: agentConfigNameSchema,
	enabled: z.boolean().default(true),
	env: envRefsSchema
});

const httpMcpSchema = baseMcpSchema.extend({
	transport: z.literal('http'),
	url: httpUrlSchema,
	headers: headersSchema
});

const sseMcpSchema = baseMcpSchema.extend({
	transport: z.literal('sse'),
	url: httpUrlSchema,
	headers: headersSchema
});

const stdioMcpSchema = baseMcpSchema.extend({
	transport: z.literal('stdio'),
	command: z.string().min(1),
	args: z.array(z.string()).default([])
});

export const projectMcpServerInputSchema = z
	.discriminatedUnion('transport', [httpMcpSchema, sseMcpSchema, stdioMcpSchema])
	.superRefine((input, ctx) => {
		if (input.transport === 'stdio') return;
		for (const [key, value] of Object.entries(input.headers)) {
			if (isSensitiveConfigKey(key) && typeof value === 'string') {
				ctx.addIssue({
					code: 'custom',
					path: ['headers', key],
					message: 'Sensitive headers must be stored as project secrets'
				});
			}
		}
	});

export type ProjectMcpServerInput = z.infer<typeof projectMcpServerInputSchema>;

export const projectSkillInputSchema = z.object({
	id: z.string().min(1).optional(),
	projectId: z.string().min(1),
	name: agentConfigNameSchema,
	enabled: z.boolean().default(true),
	description: skillDescriptionSchema,
	body: z.string().min(1)
});

export type ProjectSkillInput = z.infer<typeof projectSkillInputSchema>;

export const projectSecretInputSchema = z.object({
	projectId: z.string().min(1),
	name: agentConfigNameSchema,
	value: z.string().min(1)
});

export type ProjectSecretInput = z.infer<typeof projectSecretInputSchema>;

export const projectConfigIdSchema = z.object({
	projectId: z.string().min(1),
	id: z.string().min(1)
});

export const projectConfigEnabledSchema = projectConfigIdSchema.extend({
	enabled: z.boolean()
});

export const importProjectMcpJsonSchema = z.object({
	projectId: z.string().min(1),
	json: z.string().min(1)
});

export const importProjectSkillMarkdownSchema = z.object({
	projectId: z.string().min(1),
	name: agentConfigNameSchema.optional(),
	markdown: z.string().min(1)
});

export function normalizeSkillBody(input: {
	name: string;
	description: string;
	body: string;
}): string {
	const trimmed = input.body.trim();
	if (FRONTMATTER_RE.test(trimmed)) return `${trimmed}\n`;
	return [
		'---',
		`name: ${input.name}`,
		`description: ${JSON.stringify(input.description)}`,
		'---',
		'',
		trimmed,
		''
	].join('\n');
}
