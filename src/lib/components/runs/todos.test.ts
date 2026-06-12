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

	it('builds the current list from TaskCreate and TaskUpdate tool calls', () => {
		const events = [
			{
				payload: {
					type: 'assistant',
					message: {
						content: [
							{
								id: 'toolu_create_1',
								type: 'tool_use',
								name: 'TaskCreate',
								input: {
									subject: 'Vérifier la configuration de dotWeaver',
									activeForm: 'Vérification de la configuration',
									description: 'S’assurer que les paramètres sont corrects.'
								}
							}
						]
					}
				}
			},
			{
				payload: {
					type: 'user',
					message: {
						content: [
							{
								type: 'tool_result',
								tool_use_id: 'toolu_create_1',
								content: 'Task #1 created successfully'
							}
						]
					},
					tool_use_result: { task: { id: '1', subject: 'Vérifier la configuration de dotWeaver' } }
				}
			},
			{
				payload: {
					type: 'assistant',
					message: {
						content: [
							{
								id: 'toolu_create_2',
								type: 'tool_use',
								name: 'TaskCreate',
								input: {
									subject: "Tester l'affichage des cartes de question",
									activeForm: "Test de l'affichage des cartes"
								}
							}
						]
					}
				}
			},
			{
				payload: {
					type: 'user',
					message: {
						content: [
							{
								type: 'tool_result',
								tool_use_id: 'toolu_create_2',
								content: 'Task #2 created successfully'
							}
						]
					},
					tool_use_result: {
						task: { id: '2', subject: "Tester l'affichage des cartes de question" }
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
								name: 'TaskUpdate',
								input: { taskId: '1', status: 'completed' }
							}
						]
					}
				}
			}
		];

		expect(extractCurrentTodos(events)).toEqual([
			{
				id: '1',
				content: 'Vérifier la configuration de dotWeaver',
				status: 'completed',
				activeForm: 'Vérification de la configuration'
			},
			{
				id: '2',
				content: "Tester l'affichage des cartes de question",
				status: 'pending',
				activeForm: "Test de l'affichage des cartes"
			}
		]);
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
