import { describe, it, expect } from 'vitest';
import { extractCurrentTodos } from './todos';

describe('extractCurrentTodos', () => {
	it('returns the latest TodoWrite list from assistant tool_use events', () => {
		const events = [
			{
				payload: {
					type: 'assistant',
					message: {
						content: [
							{
								type: 'tool_use',
								name: 'TodoWrite',
								input: {
									todos: [
										{ content: 'Old task', status: 'pending', activeForm: 'Working old task' }
									]
								}
							}
						]
					}
				}
			},
			{
				payload: {
					type: 'assistant',
					message: {
						content: [
							{
								type: 'tool_use',
								name: 'TodoWrite',
								input: {
									todos: [
										{ content: 'Current', status: 'in_progress', activeForm: 'Doing current' },
										{ content: 'Done', status: 'completed', activeForm: 'Did done' }
									]
								}
							}
						]
					}
				}
			}
		];

		expect(extractCurrentTodos(events)).toEqual([
			{ content: 'Current', status: 'in_progress', activeForm: 'Doing current' },
			{ content: 'Done', status: 'completed', activeForm: 'Did done' }
		]);
	});

	it('returns an empty list when no TodoWrite exists', () => {
		expect(
			extractCurrentTodos([{ payload: { type: 'assistant', message: { content: [] } } }])
		).toEqual([]);
	});

	it('ignores malformed todos and defaults activeForm to content when missing', () => {
		const events = [
			{
				payload: {
					type: 'assistant',
					message: {
						content: [
							{
								type: 'tool_use',
								name: 'TodoWrite',
								input: {
									todos: [
										{ content: 'Keep this', status: 'pending' },
										{ content: 'Bad status', status: 'blocked' },
										{ status: 'completed' },
										null
									]
								}
							}
						]
					}
				}
			}
		];

		expect(extractCurrentTodos(events)).toEqual([
			{ content: 'Keep this', status: 'pending', activeForm: 'Keep this' }
		]);
	});
});
