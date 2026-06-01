export type DisplayEvent =
	| { kind: 'session_start'; model: string }
	| { kind: 'thinking'; text: string }
	| { kind: 'assistant_text'; markdown: string }
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
	| { kind: 'subagent'; phase: 'started' | 'progress' | 'done'; label: string; status: string | null }
	| { kind: 'rate_limit'; status: string; resetsAt: number | null }
	| { kind: 'hidden' }
	| { kind: 'raw'; json: string };

const MAX_DETAIL = 2000;
function truncate(s: string, max = MAX_DETAIL): string {
	return s.length > max ? s.slice(0, max) + '…' : s;
}

/** Décrit un appel d'outil : titre + détail lisible selon l'outil. */
export function describeToolUse(name: string, input: Record<string, unknown>): { title: string; detail: string } {
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
