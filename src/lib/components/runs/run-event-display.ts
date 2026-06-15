export type DisplayEvent =
	| { kind: 'session_start'; model: string }
	| { kind: 'thinking'; text: string }
	| { kind: 'assistant_text'; markdown: string }
	| { kind: 'user_message'; text: string }
	| { kind: 'tool_use'; tool: string; title: string; detail: string }
	| { kind: 'tool_result'; text: string; isError: boolean }
	| {
			kind: 'result';
			isError: boolean;
			subtype: string;
			numTurns: number | null;
			costUsd: number | null;
			durationMs: number | null;
			text: string;
	  }
	| {
			kind: 'subagent';
			phase: 'started' | 'progress' | 'done';
			label: string;
			status: string | null;
	  }
	| { kind: 'rate_limit'; status: string; resetsAt: number | null }
	| { kind: 'hidden' }
	| { kind: 'raw'; json: string };

const MAX_DETAIL = 2000;
function truncate(s: string, max = MAX_DETAIL): string {
	return s.length > max ? s.slice(0, max) + '…' : s;
}

interface AnyObj {
	[k: string]: unknown;
}
function asObj(v: unknown): AnyObj {
	return v && typeof v === 'object' ? (v as AnyObj) : {};
}

function isAskUserQuestionTool(name: string): boolean {
	return name === 'AskUserQuestion' || name === 'mcp__dotweaver__AskUserQuestion';
}

function toolResultText(content: unknown): string {
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) {
		return content
			.map((c) =>
				typeof c === 'string'
					? c
					: typeof asObj(c).text === 'string'
						? (asObj(c).text as string)
						: JSON.stringify(c)
			)
			.join('\n');
	}
	return content == null ? '' : JSON.stringify(content);
}

/** Décrit un appel d'outil : titre + détail lisible selon l'outil. */
export function describeToolUse(
	name: string,
	input: Record<string, unknown>
): { title: string; detail: string } {
	const str = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v ?? null));
	switch (name) {
		case 'Bash':
			return { title: 'Bash', detail: truncate(str(input.command)) };
		case 'Write':
		case 'Edit':
		case 'Read':
		case 'NotebookEdit':
			return { title: name, detail: truncate(str(input.file_path)) };
		case 'Glob':
		case 'Grep':
			return { title: name, detail: truncate(str(input.pattern)) };
		default:
			return { title: name, detail: truncate(JSON.stringify(input)) };
	}
}

/** Traduit un payload SDK brut en items affichables. Ne lève jamais : type inconnu → `raw`. */
export function normalizeEvent(payload: unknown): DisplayEvent[] {
	try {
		const p = asObj(payload);
		const type = p.type;

		if (type === 'assistant') {
			const content = asObj(p.message).content;
			const items = Array.isArray(content) ? content : [];
			const out: DisplayEvent[] = [];
			for (const raw of items) {
				const c = asObj(raw);
				if (c.type === 'thinking') out.push({ kind: 'thinking', text: String(c.thinking ?? '') });
				else if (c.type === 'text')
					out.push({ kind: 'assistant_text', markdown: String(c.text ?? '') });
				else if (c.type === 'tool_use') {
					const name = String(c.name ?? 'tool');
					if (isAskUserQuestionTool(name)) continue;
					const d = describeToolUse(name, asObj(c.input));
					out.push({
						kind: 'tool_use',
						tool: name,
						title: d.title,
						detail: d.detail
					});
				}
			}
			return out.length ? out : [{ kind: 'hidden' }];
		}

		if (type === 'user') {
			const content = asObj(p.message).content;
			const items = Array.isArray(content) ? content : [];
			const out: DisplayEvent[] = [];
			for (const raw of items) {
				const c = asObj(raw);
				if (c.type === 'tool_result')
					out.push({
						kind: 'tool_result',
						text: toolResultText(c.content),
						isError: c.is_error === true
					});
				else if (c.type === 'text')
					out.push({ kind: 'assistant_text', markdown: String(c.text ?? '') });
			}
			return out.length ? out : [{ kind: 'hidden' }];
		}

		if (type === 'user_message') {
				return [{ kind: 'user_message', text: String(p.text ?? '') }];
			}

		if (type === 'result') {
			return [
				{
					kind: 'result',
					isError: p.is_error === true,
					subtype: String(p.subtype ?? ''),
					numTurns: typeof p.num_turns === 'number' ? p.num_turns : null,
					costUsd: typeof p.total_cost_usd === 'number' ? p.total_cost_usd : null,
					durationMs: typeof p.duration_ms === 'number' ? p.duration_ms : null,
					text: typeof p.result === 'string' ? p.result : ''
				}
			];
		}

		if (type === 'system') {
			const sub = p.subtype;
			if (sub === 'init') return [{ kind: 'session_start', model: String(p.model ?? '') }];
			if (sub === 'task_started')
				return [
					{
						kind: 'subagent',
						phase: 'started',
						label: String(p.prompt ?? 'subagent task').slice(0, 80),
						status: null
					}
				];
			if (sub === 'task_progress')
				return [
					{
						kind: 'subagent',
						phase: 'progress',
						label: String(p.description ?? '').slice(0, 80),
						status: null
					}
				];
			if (sub === 'task_notification')
				return [
					{
						kind: 'subagent',
						phase: 'done',
						label: String(p.summary ?? 'subagent task').slice(0, 80),
						status: typeof p.status === 'string' ? p.status : null
					}
				];
			return [{ kind: 'raw', json: JSON.stringify(payload) }];
		}

		if (type === 'rate_limit_event') {
			const info = asObj(p.rate_limit_info);
			return [
				{
					kind: 'rate_limit',
					status: String(info.status ?? 'unknown'),
					resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt : null
				}
			];
		}

		if (type === 'runner_summary') return [{ kind: 'hidden' }];
		if (type === 'interaction_request') return [{ kind: 'hidden' }];

		return [{ kind: 'raw', json: JSON.stringify(payload) }];
	} catch {
		return [
			{
				kind: 'raw',
				json: (() => {
					try {
						return JSON.stringify(payload);
					} catch {
						return String(payload);
					}
				})()
			}
		];
	}
}
