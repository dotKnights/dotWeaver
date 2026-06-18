import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { createAskUserQuestionToolHandler } from './ask-user-question-tool.mjs';

const prompt = process.env.RUN_PROMPT;
const model = process.env.RUN_MODEL || undefined;
const resume = process.env.RUN_RESUME_SESSION || undefined;
const agent = process.env.RUN_AGENT === 'codex' ? 'codex' : 'claude';

if (!prompt) {
	console.error('RUN_PROMPT is required');
	process.exit(2);
}

// Ne jamais laisser une clé API parasite écraser l'OAuth abonnement.
if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
	delete process.env.ANTHROPIC_API_KEY;
}

function emit(obj) {
	process.stdout.write(JSON.stringify(obj) + '\n');
}

const pendingInteractionResolvers = new Map();
const inputLines = createInterface({ input: process.stdin });
let inputLinesClosed = false;
let interactionInputError;
let codexInteractionResponseDir;

function isNonArrayObject(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toError(value, fallbackMessage) {
	if (value instanceof Error) return value;
	return new Error(value ? String(value) : fallbackMessage);
}

function interactionFileName(toolUseId) {
	return `${encodeURIComponent(toolUseId)}.json`;
}

async function writeJsonAtomic(path, value) {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tmp, `${JSON.stringify(value)}\n`);
	await rename(tmp, path);
}

async function persistCodexInteractionResponse(message) {
	if (!codexInteractionResponseDir) return false;
	const file = join(codexInteractionResponseDir, interactionFileName(message.toolUseId));
	await writeJsonAtomic(file, message.response);
	return true;
}

function rejectPendingInteractions(error) {
	if (pendingInteractionResolvers.size === 0) return;

	const pendingResolvers = [...pendingInteractionResolvers.values()];
	pendingInteractionResolvers.clear();
	for (const resolver of pendingResolvers) {
		resolver.reject(error);
	}
}

function failInteractionInput(error) {
	if (!interactionInputError) interactionInputError = error;
	rejectPendingInteractions(interactionInputError);
}

function handleInteractionInputError(error) {
	failInteractionInput(toError(error, 'AskUserQuestion interaction input failed'));
}

function cleanupInteractionInput() {
	inputLines.removeListener('error', handleInteractionInputError);
	process.stdin.removeListener('error', handleInteractionInputError);

	if (!inputLinesClosed) {
		inputLinesClosed = true;
		inputLines.close();
	}
}

inputLines.on('line', (line) => {
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return;
	}
	if (message?.type !== 'interaction_response' || !message.toolUseId) return;
	const resolver = pendingInteractionResolvers.get(message.toolUseId);

	if (!isNonArrayObject(message.response) || !isNonArrayObject(message.response.answers)) {
		if (resolver) {
			pendingInteractionResolvers.delete(message.toolUseId);
			resolver.reject(
				new Error(`Malformed interaction_response for tool use ${message.toolUseId}`)
			);
		}
		return;
	}

	if (!resolver) {
		void persistCodexInteractionResponse(message).catch((error) => {
			failInteractionInput(error);
		});
		return;
	}

	pendingInteractionResolvers.delete(message.toolUseId);
	resolver(message.response);
});

inputLines.on('close', () => {
	inputLinesClosed = true;
	failInteractionInput(new Error('AskUserQuestion interaction input closed'));
});

inputLines.on('error', handleInteractionInputError);
process.stdin.on('error', handleInteractionInputError);

function waitForInteractionResponse(toolUseId, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason ?? new Error('AskUserQuestion interaction was aborted'));
			return;
		}
		if (interactionInputError) {
			reject(interactionInputError);
			return;
		}

		const existingResolver = pendingInteractionResolvers.get(toolUseId);
		if (existingResolver) {
			pendingInteractionResolvers.delete(toolUseId);
			existingResolver.reject(
				new Error(`Duplicate AskUserQuestion wait for tool use ${toolUseId}`)
			);
		}

		let settled = false;
		let resolver;

		const cleanup = () => {
			if (signal) signal.removeEventListener('abort', handleAbort);
		};

		const handleAbort = () => {
			if (settled) return;
			settled = true;
			if (pendingInteractionResolvers.get(toolUseId) === resolver) {
				pendingInteractionResolvers.delete(toolUseId);
			}
			cleanup();
			reject(signal.reason ?? new Error('AskUserQuestion interaction was aborted'));
		};

		resolver = (response) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(response);
		};
		resolver.reject = (error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};

		pendingInteractionResolvers.set(toolUseId, resolver);
		if (signal) signal.addEventListener('abort', handleAbort, { once: true });
	});
}

const askUserQuestionHandler = createAskUserQuestionToolHandler({
	emit,
	waitForInteractionResponse
});

const askUserQuestionServer = createSdkMcpServer({
	name: 'dotweaver',
	version: '1.0.0',
	tools: [
		tool(
			'AskUserQuestion',
			'Ask the user one to four structured questions and wait for their answers before continuing.',
			{
				questions: z
					.array(
						z.object({
							header: z.string().min(1),
							question: z.string().min(1),
							multiSelect: z.boolean(),
							options: z
								.array(
									z.object({
										label: z.string().min(1),
										description: z.string().min(1),
										preview: z.string().optional()
									})
								)
								.min(2)
								.max(4)
						})
					)
					.min(1)
					.max(4)
			},
			askUserQuestionHandler,
			{ alwaysLoad: true }
		)
	]
});

const gitc = (args) => execFileSync('git', args, { cwd: '/workspace' }).toString();

function ensureGitExclude(pattern) {
	const exclude = gitc(['rev-parse', '--git-path', 'info/exclude']).trim();
	const excludePath = exclude.startsWith('/') ? exclude : join('/workspace', exclude);
	mkdirSync(dirname(excludePath), { recursive: true });
	appendFileSync(excludePath, `\n# dotWeaver runner state\n${pattern}\n`);
}

function setupGit() {
	// Le checkout bind-monté appartient à l'uid de l'hôte (≠ uid du conteneur) → git refuse
	// le repo (« dubious ownership ») tant qu'on ne le déclare pas sûr.
	gitc(['config', '--global', '--add', 'safe.directory', '/workspace']);

	// Identité git pour les commits de l'agent.
	gitc(['config', 'user.email', 'agent@dotweaver.local']);
	gitc(['config', 'user.name', 'dotWeaver']);
	ensureGitExclude('.dotweaver/');
}

async function runClaude() {
	let sessionId;
	let lastResult;

	for await (const message of query({
		prompt,
		options: {
			cwd: '/workspace',
			model,
			resume,
			settingSources: ['project'],
			mcpServers: { dotweaver: askUserQuestionServer },
			toolAliases: { AskUserQuestion: 'mcp__dotweaver__AskUserQuestion' },
			toolConfig: { askUserQuestion: { previewFormat: 'markdown' } },
			// Le binaire embarqué par le SDK (arm64) est cassé → on force la vraie CLI.
			pathToClaudeCodeExecutable: '/usr/local/bin/claude',
			// On tourne en root (cf. Dockerfile) ; `--dangerously-skip-permissions`
			// (= bypassPermissions) est refusé en root. On auto-approuve donc via
			// canUseTool (voie sanctionnée pour l'automatisation headless). Le conteneur
			// reste la frontière de sécurité.
			canUseTool: async (name, input, context) => {
				if (name !== 'AskUserQuestion') return { behavior: 'allow', updatedInput: input };

				const toolUseId = context?.toolUseID;
				if (!toolUseId) {
					return {
						behavior: 'deny',
						message: 'AskUserQuestion could not be correlated to a tool use id',
						interrupt: true
					};
				}

				emit({
					type: 'interaction_request',
					kind: 'ask_user_question',
					toolUseId,
					request: input
				});

				const response = await waitForInteractionResponse(toolUseId, context?.signal);
				return {
					behavior: 'allow',
					updatedInput: {
						...input,
						answers: response?.answers ?? {},
						...(response?.response ? { response: response.response } : {}),
						...(response?.annotations ? { annotations: response.annotations } : {})
					}
				};
			},
			// Ancrage : sans ça, l'agent peut écrire hors du repo (ex. /Users/...).
			systemPrompt: {
				type: 'preset',
				preset: 'claude_code',
				append:
					'Your working directory is /workspace, the root of a git repository. Create and edit files ONLY inside /workspace, using paths relative to it. Never write outside /workspace.'
			}
		}
	})) {
		if (message.type === 'system' && message.subtype === 'init') {
			sessionId = message.session_id;
		}
		if (message.type === 'result') {
			lastResult = message;
		}
		emit(message);
	}

	return { sessionId, lastResult };
}

function tomlString(value) {
	return JSON.stringify(String(value));
}

function tomlArray(values) {
	return `[${values.map(tomlString).join(', ')}]`;
}

function tomlInlineTable(record) {
	const entries = Object.entries(record ?? {});
	if (entries.length === 0) return '{}';
	return `{ ${entries.map(([key, value]) => `${key} = ${tomlString(value)}`).join(', ')} }`;
}

function expandEnvPlaceholders(value) {
	if (typeof value !== 'string') return value;
	return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name) => {
		return process.env[name] ?? '';
	});
}

function expandRecord(record) {
	return Object.fromEntries(
		Object.entries(record ?? {}).map(([key, value]) => [key, expandEnvPlaceholders(value)])
	);
}

async function readProjectMcpJson() {
	try {
		const raw = await readFile('/workspace/.mcp.json', 'utf8');
		const parsed = JSON.parse(raw);
		return isNonArrayObject(parsed?.mcpServers) ? parsed.mcpServers : {};
	} catch (error) {
		if (error?.code === 'ENOENT') return {};
		throw error;
	}
}

function appendCodexMcpServer(lines, name, server) {
	if (!isNonArrayObject(server)) return;
	lines.push('', `[mcp_servers.${name}]`, 'enabled = true');

	if (server.type === 'stdio') {
		lines.push(`command = ${tomlString(server.command)}`);
		if (Array.isArray(server.args)) lines.push(`args = ${tomlArray(server.args)}`);
		const env = expandRecord(server.env);
		if (Object.keys(env).length > 0) lines.push(`env = ${tomlInlineTable(env)}`);
		return;
	}

	if (typeof server.url === 'string') {
		lines.push(`url = ${tomlString(server.url)}`);
	}
	const headers = expandRecord(server.headers);
	if (Object.keys(headers).length > 0) {
		lines.push(`http_headers = ${tomlInlineTable(headers)}`);
	}
}

function codexConfigToml({ codexHome, interactionDir, mcpServers }) {
	const lines = [
		'approval_policy = "never"',
		'sandbox_mode = "danger-full-access"',
		'web_search = "disabled"',
		'cli_auth_credentials_store = "file"',
		'mcp_oauth_credentials_store = "file"',
		'project_doc_max_bytes = 32768',
		`log_dir = ${tomlString(join(codexHome, 'log'))}`,
		'',
		'[projects."/workspace"]',
		'trust_level = "trusted"',
		'',
		'[mcp_servers.dotweaver]',
		'enabled = true',
		'command = "node"',
		'args = ["/runner/dotweaver-mcp-server.mjs"]',
		`env = { DOTWEAVER_INTERACTION_DIR = ${tomlString(interactionDir)} }`
	];

	for (const [name, server] of Object.entries(mcpServers)) {
		appendCodexMcpServer(lines, name, server);
	}

	lines.push('');
	return lines.join('\n');
}

async function prepareCodexHome(interactionDir) {
	const codexHome = process.env.CODEX_HOME || '/workspace/.dotweaver/codex-home';
	const mcpServers = await readProjectMcpJson();
	await mkdir(codexHome, { recursive: true });
	if (process.env.CODEX_AUTH_JSON_SOURCE) {
		await copyFile(process.env.CODEX_AUTH_JSON_SOURCE, join(codexHome, 'auth.json'));
	}
	await writeFile(
		join(codexHome, 'config.toml'),
		codexConfigToml({ codexHome, interactionDir, mcpServers })
	);
	process.env.CODEX_HOME = codexHome;
	return codexHome;
}

function hasCodexAuth(codexHome) {
	return (
		Boolean(process.env.CODEX_API_KEY) ||
		Boolean(process.env.CODEX_ACCESS_TOKEN) ||
		existsSync(join(codexHome, 'auth.json'))
	);
}

function codexPrompt() {
	return `${prompt}

dotWeaver runtime constraints:
- Your working directory is /workspace, the root of a git repository.
- Create and edit files only inside /workspace, using paths relative to it.
- Never write outside /workspace.
- Do not push branches or open pull requests; dotWeaver handles review, push, and PR creation after the run.`;
}

function codexToolName(item) {
	if (typeof item?.tool_name === 'string') return item.tool_name;
	if (typeof item?.name === 'string') return item.name;
	if (typeof item?.server === 'string' && typeof item?.tool === 'string') {
		return `mcp__${item.server}__${item.tool}`;
	}
	if (typeof item?.tool === 'string') return item.tool;
	return 'tool';
}

function codexToolInput(item) {
	if (isNonArrayObject(item?.input)) return item.input;
	if (isNonArrayObject(item?.arguments)) return item.arguments;
	if (typeof item?.command === 'string') return { command: item.command };
	return {};
}

function codexToolResultText(item) {
	for (const key of ['output', 'stdout', 'stderr', 'result', 'text']) {
		if (typeof item?.[key] === 'string' && item[key].length > 0) return item[key];
	}
	if (item?.exit_code !== undefined) return `exit code ${item.exit_code}`;
	return JSON.stringify(item ?? {});
}

function emitCodexEvent(event) {
	if (event.type === 'thread.started') {
		emit({
			type: 'system',
			subtype: 'init',
			session_id: event.thread_id,
			model: model ?? 'codex'
		});
		return { sessionId: event.thread_id };
	}

	if (event.type === 'turn.completed') {
		emit({
			type: 'result',
			subtype: 'success',
			is_error: false,
			num_turns: null,
			total_cost_usd: null,
			duration_ms: null,
			result: ''
		});
		return { lastResult: { subtype: 'success' } };
	}

	if (event.type === 'turn.failed' || event.type === 'error') {
		emit({ type: 'error', error: String(event.error ?? event.message ?? 'Codex turn failed') });
		return {};
	}

	const item = event.item;
	if (!isNonArrayObject(item)) return {};

	if (event.type === 'item.started') {
		if (item.type === 'command_execution') {
			emit({
				type: 'assistant',
				message: {
					content: [{ type: 'tool_use', name: 'Bash', input: { command: item.command ?? '' } }]
				}
			});
			return {};
		}
		if (item.type === 'mcp_tool_call' || item.type === 'tool_call') {
			emit({
				type: 'assistant',
				message: {
					content: [
						{
							type: 'tool_use',
							name: codexToolName(item),
							input: codexToolInput(item)
						}
					]
				}
			});
			return {};
		}
	}

	if (event.type === 'item.completed') {
		if (item.type === 'agent_message' && typeof item.text === 'string') {
			emit({ type: 'assistant', message: { content: [{ type: 'text', text: item.text }] } });
			return {};
		}
		if (item.type === 'reasoning' && typeof item.text === 'string') {
			emit({
				type: 'assistant',
				message: { content: [{ type: 'thinking', thinking: item.text }] }
			});
			return {};
		}
		if (
			item.type === 'command_execution' ||
			item.type === 'mcp_tool_call' ||
			item.type === 'tool_call'
		) {
			emit({
				type: 'user',
				message: {
					content: [
						{
							type: 'tool_result',
							content: codexToolResultText(item),
							is_error: item.status === 'failed' || item.exit_code > 0
						}
					]
				}
			});
			return {};
		}
	}

	emit({ type: 'system', subtype: 'codex_event', event });
	return {};
}

function startCodexInteractionRequestPump(requestDir) {
	const seen = new Set();
	let stopped = false;

	async function scan() {
		if (stopped) return;
		let files;
		try {
			files = await readdir(requestDir);
		} catch {
			return;
		}
		for (const file of files) {
			if (!file.endsWith('.json') || seen.has(file)) continue;
			seen.add(file);
			try {
				const raw = await readFile(join(requestDir, file), 'utf8');
				emit(JSON.parse(raw));
			} catch (error) {
				emit({ type: 'error', error: `Could not read interaction request: ${error.message}` });
			}
		}
	}

	const timer = setInterval(() => {
		void scan();
	}, 250);
	void scan();

	return () => {
		stopped = true;
		clearInterval(timer);
	};
}

async function runCodex() {
	const interactionDir = '/workspace/.dotweaver/interactions';
	const requestDir = join(interactionDir, 'requests');
	const responseDir = join(interactionDir, 'responses');
	await rm(interactionDir, { recursive: true, force: true });
	await mkdir(requestDir, { recursive: true });
	await mkdir(responseDir, { recursive: true });
	codexInteractionResponseDir = responseDir;

	const codexHome = await prepareCodexHome(interactionDir);
	if (!hasCodexAuth(codexHome)) {
		throw new Error(
			'CODEX_API_KEY, CODEX_ACCESS_TOKEN, or a Codex auth cache is required for Codex runs'
		);
	}

	const stopInteractions = startCodexInteractionRequestPump(requestDir);
	let sessionId;
	let lastResult;

	const args = resume
		? [
				'exec',
				'resume',
				'--json',
				'--dangerously-bypass-approvals-and-sandbox',
				'--dangerously-bypass-hook-trust',
				...(model ? ['--model', model] : []),
				resume,
				codexPrompt()
			]
		: [
				'exec',
				'--json',
				'--dangerously-bypass-approvals-and-sandbox',
				'--dangerously-bypass-hook-trust',
				...(model ? ['--model', model] : []),
				codexPrompt()
			];

	try {
		await new Promise((resolve, reject) => {
			const child = spawn('codex', args, { cwd: '/workspace', env: process.env });
			const out = createInterface({ input: child.stdout });
			const err = createInterface({ input: child.stderr });

			out.on('line', (line) => {
				let event;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}
				const update = emitCodexEvent(event);
				if (update.sessionId) sessionId = update.sessionId;
				if (update.lastResult) lastResult = update.lastResult;
			});

			err.on('line', (line) => {
				if (line.trim()) emit({ type: 'system', subtype: 'codex_stderr', text: line });
			});

			child.on('error', reject);
			child.on('close', (code) => {
				if (code === 0) resolve();
				else reject(new Error(`Codex exited with code ${code ?? -1}`));
			});
		});
	} finally {
		stopInteractions();
		codexInteractionResponseDir = undefined;
		await rm(join(codexHome, 'config.toml'), { force: true });
	}

	return { sessionId, lastResult };
}

function commitAndSummarize(sessionId, lastResult) {
	// Commit de sécurité : capture tout changement non commité par l'agent.
	const status = gitc(['status', '--porcelain']).trim();
	if (status) {
		gitc(['add', '-A']);
		gitc(['commit', '-m', 'chore: agent changes']);
	}

	const head = gitc(['rev-parse', 'HEAD']).trim();
	emit({
		type: 'runner_summary',
		session_id: sessionId,
		head,
		result_subtype: lastResult?.subtype ?? null
	});
}

try {
	setupGit();
	const result = agent === 'codex' ? await runCodex() : await runClaude();
	commitAndSummarize(result.sessionId, result.lastResult);
} catch (err) {
	emit({ type: 'error', error: String(err?.message ?? err) });
	process.exit(1);
} finally {
	cleanupInteractionInput();
}
