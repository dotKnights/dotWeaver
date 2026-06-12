import { query } from '@anthropic-ai/claude-agent-sdk';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';

const prompt = process.env.RUN_PROMPT;
const model = process.env.RUN_MODEL || undefined;
const resume = process.env.RUN_RESUME_SESSION || undefined;

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

function isNonArrayObject(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toError(value, fallbackMessage) {
	if (value instanceof Error) return value;
	return new Error(value ? String(value) : fallbackMessage);
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
	if (!resolver) return;

	if (!isNonArrayObject(message.response) || !isNonArrayObject(message.response.answers)) {
		pendingInteractionResolvers.delete(message.toolUseId);
		resolver.reject(new Error(`Malformed interaction_response for tool use ${message.toolUseId}`));
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

const gitc = (args) => execFileSync('git', args, { cwd: '/workspace' }).toString();

// Le checkout bind-monté appartient à l'uid de l'hôte (≠ uid du conteneur) → git refuse
// le repo (« dubious ownership ») tant qu'on ne le déclare pas sûr.
gitc(['config', '--global', '--add', 'safe.directory', '/workspace']);

// Identité git pour les commits de l'agent.
gitc(['config', 'user.email', 'agent@dotweaver.local']);
gitc(['config', 'user.name', 'dotWeaver']);

let sessionId;
let lastResult;
let queryError;

try {
	for await (const message of query({
		prompt,
		options: {
			cwd: '/workspace',
			model,
			resume,
			settingSources: ['project'],
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
} catch (err) {
	queryError = err;
} finally {
	cleanupInteractionInput();
}

if (queryError) {
	emit({ type: 'error', error: String(queryError?.message ?? queryError) });
	process.exit(1);
}

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
