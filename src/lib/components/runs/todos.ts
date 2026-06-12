export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
	id?: string;
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

function normalizeStatus(value: unknown): TodoStatus | null {
	return value === 'pending' || value === 'in_progress' || value === 'completed' ? value : null;
}

function taskIdFromResult(payload: AnyObj, toolResult: AnyObj): string | null {
	const structured = asObj(payload.tool_use_result);
	const task = asObj(structured.task);
	if (typeof task.id === 'string' && task.id.length > 0) return task.id;
	if (typeof structured.taskId === 'string' && structured.taskId.length > 0) {
		return structured.taskId;
	}

	const content = toolResult.content;
	if (typeof content !== 'string') return null;
	const match = content.match(/\bTask\s+#([^\s]+)\b/i);
	return match?.[1] ?? null;
}

function replaceTodoId(current: TodoItem[], fromId: string, toId: string): TodoItem[] {
	if (fromId === toId) return current;
	return current.map((todo) => (todo.id === fromId ? { ...todo, id: toId } : todo));
}

function updateTodoStatus(current: TodoItem[], taskId: string, status: TodoStatus): TodoItem[] {
	return current.map((todo) => (todo.id === taskId ? { ...todo, status } : todo));
}

export function extractCurrentTodos(events: Array<{ payload: unknown }>): TodoItem[] {
	let current: TodoItem[] = [];
	let nextGeneratedTaskId = 1;
	const createToolIds = new Map<string, string>();

	for (const event of events) {
		const payload = asObj(event.payload);
		const content = asObj(payload.message).content;
		if (!Array.isArray(content)) continue;

		if (payload.type === 'assistant') {
			for (const item of content) {
				const block = asObj(item);
				if (block.type !== 'tool_use') continue;

				if (block.name === 'TodoWrite') {
					const todos = asObj(block.input).todos;
					if (!Array.isArray(todos)) continue;
					current = todos.flatMap((todo) => {
						const normalized = normalizeTodo(todo);
						return normalized ? [normalized] : [];
					});
				} else if (block.name === 'TaskCreate') {
					const input = asObj(block.input);
					if (typeof input.subject !== 'string' || input.subject.length === 0) continue;
					const taskId = String(nextGeneratedTaskId++);
					if (typeof block.id === 'string') createToolIds.set(block.id, taskId);
					current = [
						...current,
						{
							id: taskId,
							content: input.subject,
							status: 'pending',
							activeForm:
								typeof input.activeForm === 'string' && input.activeForm.length > 0
									? input.activeForm
									: input.subject
						}
					];
				} else if (block.name === 'TaskUpdate') {
					const input = asObj(block.input);
					const status = normalizeStatus(input.status);
					if (!status || typeof input.taskId !== 'string') continue;
					current = updateTodoStatus(current, input.taskId, status);
				}
			}
		} else if (payload.type === 'user') {
			for (const item of content) {
				const block = asObj(item);
				if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
				const previousId = createToolIds.get(block.tool_use_id);
				if (!previousId) continue;
				const actualId = taskIdFromResult(payload, block);
				if (!actualId) continue;
				current = replaceTodoId(current, previousId, actualId);
				createToolIds.set(block.tool_use_id, actualId);
			}
		}
	}

	return current;
}
