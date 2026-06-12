export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
	content: string;
	status: TodoStatus;
	activeForm: string;
}

interface AnyObj {
	[k: string]: unknown;
}

function asObj(value: unknown): AnyObj {
	return value && typeof value === 'object' ? (value as AnyObj) : {};
}

function normalizeTodo(value: unknown): TodoItem | null {
	const todo = asObj(value);
	const status = todo.status;
	if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') return null;
	if (typeof todo.content !== 'string') return null;
	return {
		content: todo.content,
		status,
		activeForm: typeof todo.activeForm === 'string' ? todo.activeForm : todo.content
	};
}

export function extractCurrentTodos(events: Array<{ payload: unknown }>): TodoItem[] {
	let current: TodoItem[] = [];

	for (const event of events) {
		const payload = asObj(event.payload);
		if (payload.type !== 'assistant') continue;
		const content = asObj(payload.message).content;
		if (!Array.isArray(content)) continue;

		for (const item of content) {
			const block = asObj(item);
			if (block.type !== 'tool_use' || block.name !== 'TodoWrite') continue;
			const todos = asObj(block.input).todos;
			if (!Array.isArray(todos)) continue;
			current = todos.flatMap((todo) => {
				const normalized = normalizeTodo(todo);
				return normalized ? [normalized] : [];
			});
		}
	}

	return current;
}
