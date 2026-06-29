import {
	agentConfigNameSchema,
	isSensitiveConfigKey,
	projectMcpServerInputSchema,
	type ProjectMcpServerInput
} from '$lib/schemas/project-agent-config';

type McpTransport = ProjectMcpServerInput['transport'];
type EnvRefs = Record<string, { secretName: string }>;
type HeaderValues = Extract<ProjectMcpServerInput, { transport: 'http' }>['headers'];
type HeaderSecretRef = Exclude<HeaderValues[string], string>;

type ImportedProjectMcpSecret = { name: string; value: string };
type ImportedProjectMcpServer = {
	input: ProjectMcpServerInput;
	secrets: ImportedProjectMcpSecret[];
};

export class ProjectMcpImportError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ProjectMcpImportError';
	}
}

const ENV_PLACEHOLDER_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}$/;
const ENV_PLACEHOLDER_IN_STRING_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g;

function fail(message: string): never {
	throw new ProjectMcpImportError(message);
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		fail(message);
	}
	return value as Record<string, unknown>;
}

function optionalRecord(value: unknown, message: string): Record<string, unknown> {
	if (value === undefined) return {};
	return requireRecord(value, message);
}

function requireString(value: unknown, message: string): string {
	if (typeof value !== 'string' || value.length === 0) {
		fail(message);
	}
	return value;
}

function importSecretName(serverName: string, key: string, usedNames: Set<string>): string {
	const sanitized = `${serverName}_${key}`
		.replace(/[^A-Za-z0-9_-]+/g, '_')
		.replace(/_+/g, '_')
		.replace(/^_+|_+$/g, '');
	const base = sanitized.length > 0 ? sanitized.slice(0, 80) : 'imported_secret';
	for (let index = 1; index < 1000; index += 1) {
		const suffix = index === 1 ? '' : `_${index}`;
		const candidate = `${base.slice(0, 80 - suffix.length)}${suffix}`;
		if (!usedNames.has(candidate) && agentConfigNameSchema.safeParse(candidate).success) {
			usedNames.add(candidate);
			return candidate;
		}
	}
	fail(`MCP \`${serverName}\` could not generate a project secret name`);
}

function secretRefRecord(
	value: unknown,
	serverName: string,
	itemName: string
): { secretName: string } {
	const record = requireRecord(value, `MCP \`${serverName}\` ${itemName} must be a secret ref`);
	const secretName = record.secretName;
	if (typeof secretName !== 'string' || secretName.length === 0) {
		fail(`MCP \`${serverName}\` ${itemName} must be a secret ref`);
	}
	return { secretName };
}

function headerSecretRefRecord(
	value: unknown,
	serverName: string,
	headerName: string
): HeaderSecretRef {
	const record = requireRecord(
		value,
		`MCP \`${serverName}\` header \`${headerName}\` must be a secret ref`
	);
	const secretName = record.secretName;
	const prefix = record.prefix;
	const suffix = record.suffix;
	if (typeof secretName !== 'string' || secretName.length === 0) {
		fail(`MCP \`${serverName}\` header \`${headerName}\` must be a secret ref`);
	}
	if (prefix !== undefined && typeof prefix !== 'string') {
		fail(`MCP \`${serverName}\` header \`${headerName}\` prefix must be a string`);
	}
	if (suffix !== undefined && typeof suffix !== 'string') {
		fail(`MCP \`${serverName}\` header \`${headerName}\` suffix must be a string`);
	}
	return {
		secretName,
		prefix: prefix || undefined,
		suffix: suffix || undefined
	};
}

function generatedSecretRef(
	value: string,
	serverName: string,
	key: string,
	usedNames: Set<string>
): { ref: { secretName: string }; secret: ImportedProjectMcpSecret } {
	if (value.length === 0) {
		fail(`MCP \`${serverName}\` secret value for \`${key}\` cannot be empty`);
	}
	const name = importSecretName(serverName, key, usedNames);
	return {
		ref: { secretName: name },
		secret: { name, value }
	};
}

function containsEnvPlaceholder(value: string): boolean {
	ENV_PLACEHOLDER_IN_STRING_RE.lastIndex = 0;
	const hasPlaceholder = ENV_PLACEHOLDER_IN_STRING_RE.test(value);
	ENV_PLACEHOLDER_IN_STRING_RE.lastIndex = 0;
	return hasPlaceholder;
}

function headerTemplateSecretRef(
	value: string,
	serverName: string,
	headerName: string
): HeaderSecretRef | null {
	ENV_PLACEHOLDER_IN_STRING_RE.lastIndex = 0;
	const matches = [...value.matchAll(ENV_PLACEHOLDER_IN_STRING_RE)];
	ENV_PLACEHOLDER_IN_STRING_RE.lastIndex = 0;
	if (matches.length === 0) return null;
	if (matches.length > 1) {
		fail(`MCP \`${serverName}\` header \`${headerName}\` can reference only one secret`);
	}
	const match = matches[0];
	const index = match.index ?? 0;
	const token = match[0];
	return {
		secretName: match[1],
		prefix: value.slice(0, index) || undefined,
		suffix: value.slice(index + token.length) || undefined
	};
}

function envSecretRef(
	value: unknown,
	serverName: string,
	envName: string,
	usedNames: Set<string>
): { ref: { secretName: string }; secret?: ImportedProjectMcpSecret } {
	if (typeof value === 'string') {
		const placeholder = ENV_PLACEHOLDER_RE.exec(value);
		if (placeholder) return { ref: { secretName: placeholder[1] } };
		if (containsEnvPlaceholder(value)) {
			fail(`MCP \`${serverName}\` env \`${envName}\` cannot contain partial placeholders`);
		}
		return generatedSecretRef(value, serverName, envName, usedNames);
	}
	return { ref: secretRefRecord(value, serverName, `env \`${envName}\``) };
}

function optionalEnvRefs(
	value: unknown,
	serverName: string,
	usedNames: Set<string>
): { env: EnvRefs; secrets: ImportedProjectMcpSecret[] } {
	const record = optionalRecord(value, `MCP \`${serverName}\` env must be an object`);
	const output: EnvRefs = {};
	const secrets: ImportedProjectMcpSecret[] = [];
	for (const [envName, item] of Object.entries(record)) {
		const imported = envSecretRef(item, serverName, envName, usedNames);
		output[envName] = imported.ref;
		if (imported.secret) secrets.push(imported.secret);
	}
	return { env: output, secrets };
}

function optionalHeaderValues(
	value: unknown,
	serverName: string,
	usedNames: Set<string>
): { headers: HeaderValues; secrets: ImportedProjectMcpSecret[] } {
	const record = optionalRecord(value, `MCP \`${serverName}\` headers must be an object`);
	const headers: HeaderValues = {};
	const secrets: ImportedProjectMcpSecret[] = [];
	for (const [key, item] of Object.entries(record)) {
		if (typeof item === 'string') {
			const headerRef = headerTemplateSecretRef(item, serverName, key);
			if (headerRef) {
				headers[key] = headerRef;
			} else if (isSensitiveConfigKey(key)) {
				const imported = generatedSecretRef(item, serverName, key, usedNames);
				headers[key] = imported.ref;
				secrets.push(imported.secret);
			} else {
				headers[key] = item;
			}
			continue;
		}
		headers[key] = headerSecretRefRecord(item, serverName, key);
	}
	return { headers, secrets };
}

function importTransport(server: Record<string, unknown>, serverName: string): McpTransport {
	const transport = server.type ?? server.transport;
	if (transport === 'stdio' || transport === 'sse' || transport === 'http') return transport;
	if (transport !== undefined) {
		fail(`MCP \`${serverName}\` has unsupported transport`);
	}
	if (server.command !== undefined && server.url === undefined) return 'stdio';
	if (server.url !== undefined) return 'http';
	return 'http';
}

function parseImportedProjectMcpServerInput(name: string, input: unknown): ProjectMcpServerInput {
	const parsed = projectMcpServerInputSchema.safeParse(input);
	if (!parsed.success) {
		const message = parsed.error.issues[0]?.message ?? 'Invalid MCP server config';
		fail(`MCP \`${name}\` ${message}`);
	}
	return parsed.data;
}

function importProjectMcpServerInput(
	projectId: string,
	name: string,
	serverValue: unknown,
	usedNames: Set<string>
): ImportedProjectMcpServer {
	const server = requireRecord(serverValue, `MCP \`${name}\` config must be an object`);
	const transport = importTransport(server, name);
	const env = optionalEnvRefs(server.env, name, usedNames);
	const base = {
		projectId,
		name,
		enabled: true,
		env: env.env
	};

	if (transport === 'stdio') {
		const args =
			server.args === undefined ? [] : Array.isArray(server.args) ? server.args.map(String) : [];
		if (server.args !== undefined && !Array.isArray(server.args)) {
			fail(`MCP \`${name}\` args must be an array`);
		}
		return {
			input: parseImportedProjectMcpServerInput(name, {
				...base,
				transport,
				command: requireString(server.command, `MCP \`${name}\` command must be a string`),
				args
			}),
			secrets: env.secrets
		};
	}

	const headers = optionalHeaderValues(server.headers, name, usedNames);
	return {
		input: parseImportedProjectMcpServerInput(name, {
			...base,
			transport,
			url: requireString(server.url, `MCP \`${name}\` url must be a string`),
			headers: headers.headers
		}),
		secrets: [...env.secrets, ...headers.secrets]
	};
}

export function parseProjectMcpJsonServers(json: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		fail('Invalid .mcp.json');
	}

	const root = requireRecord(parsed, 'Invalid .mcp.json');
	return requireRecord(root.mcpServers, '.mcp.json mcpServers must be an object');
}

export function parseProjectMcpJsonImport(input: {
	projectId: string;
	mcpServers: Record<string, unknown>;
	existingSecretNames: Iterable<string>;
}): ImportedProjectMcpServer[] {
	const generatedSecretNames = new Set(input.existingSecretNames);
	return Object.entries(input.mcpServers).map(([name, server]) =>
		importProjectMcpServerInput(input.projectId, name, server, generatedSecretNames)
	);
}
