import { query } from '@anthropic-ai/claude-agent-sdk';
import { execFileSync } from 'node:child_process';

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

const gitc = (args) => execFileSync('git', args, { cwd: '/workspace' }).toString();

// Le checkout bind-monté appartient à l'uid de l'hôte (≠ uid du conteneur) → git refuse
// le repo (« dubious ownership ») tant qu'on ne le déclare pas sûr.
gitc(['config', '--global', '--add', 'safe.directory', '/workspace']);

// Identité git pour les commits de l'agent.
gitc(['config', 'user.email', 'agent@dotweaver.local']);
gitc(['config', 'user.name', 'dotWeaver agent']);

let sessionId;
let lastResult;

try {
	for await (const message of query({
		prompt,
		options: {
			cwd: '/workspace',
			model,
			resume,
			settingSources: ['project'],
			permissionMode: 'bypassPermissions'
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
	emit({ type: 'error', error: String(err?.message ?? err) });
	process.exit(1);
}

// Commit de sécurité : capture tout changement non commité par l'agent.
const status = gitc(['status', '--porcelain']).trim();
if (status) {
	gitc(['add', '-A']);
	gitc(['commit', '-m', 'chore: agent changes']);
}

const head = gitc(['rev-parse', 'HEAD']).trim();
emit({ type: 'runner_summary', session_id: sessionId, head, result_subtype: lastResult?.subtype ?? null });
