import { describe, it, expect } from 'vitest';
import {
	OTHER_OPTION_VALUE,
	askUserQuestionRequestSchema,
	answerRunInteractionSchema,
	validateAskUserQuestionResponse
} from '$lib/schemas/run-interactions';

const request = {
	questions: [
		{
			question: 'Which layout?',
			header: 'Layout',
			multiSelect: false,
			options: [
				{ label: 'Compact', description: 'Dense inspector' },
				{ label: 'Split', description: 'Events and side panel' }
			]
		},
		{
			question: 'Which panels?',
			header: 'Panels',
			multiSelect: true,
			options: [
				{ label: 'Todos', description: 'Show current todo state' },
				{ label: 'Diff', description: 'Show diff summary' }
			]
		}
	]
};

describe('answerRunInteractionSchema', () => {
	it('accepts selected answers keyed by question text', () => {
		expect(
			answerRunInteractionSchema.safeParse({
				interactionId: 'i1',
				answers: {
					'Which layout?': { selected: ['Compact'] },
					'Which panels?': { selected: ['Todos', 'Diff'] }
				}
			}).success
		).toBe(true);
	});
});

describe('askUserQuestionRequestSchema', () => {
	it('rejects duplicate question text', () => {
		expect(() =>
			askUserQuestionRequestSchema.parse({
				questions: [
					request.questions[0],
					{ ...request.questions[1], question: request.questions[0].question }
				]
			})
		).toThrow(/duplicate question/i);
	});

	it('rejects duplicate option labels within a question', () => {
		expect(() =>
			askUserQuestionRequestSchema.parse({
				questions: [
					{
						...request.questions[0],
						options: [
							{ label: 'Compact', description: 'Dense inspector' },
							{ label: 'Compact', description: 'Same label conflict' }
						]
					}
				]
			})
		).toThrow(/duplicate option/i);
	});

	it('rejects option labels that collide with the synthetic Other value', () => {
		expect(() =>
			askUserQuestionRequestSchema.parse({
				questions: [
					{
						...request.questions[0],
						options: [
							{ label: OTHER_OPTION_VALUE, description: 'Synthetic value conflict' },
							{ label: 'Split', description: 'Events and side panel' }
						]
					}
				]
			})
		).toThrow(/Other|__other__/);
	});
});

describe('validateAskUserQuestionResponse', () => {
	it('serializes complete answers into Claude AskUserQuestion output shape', () => {
		const result = validateAskUserQuestionResponse(request, {
			'Which layout?': { selected: ['Compact'] },
			'Which panels?': { selected: ['Todos', 'Diff'] }
		});

		expect(result).toEqual({
			answers: {
				'Which layout?': 'Compact',
				'Which panels?': 'Todos, Diff'
			}
		});
	});

	it('requires every question to be answered', () => {
		expect(() =>
			validateAskUserQuestionResponse(request, {
				'Which layout?': { selected: ['Compact'] }
			})
		).toThrow(/Which panels/);
	});

	it('requires otherText when the Other option is selected', () => {
		expect(() =>
			validateAskUserQuestionResponse(request, {
				'Which layout?': { selected: [OTHER_OPTION_VALUE] },
				'Which panels?': { selected: ['Todos'] }
			})
		).toThrow(/Other/);
	});

	it('uses otherText as the serialized answer', () => {
		const result = validateAskUserQuestionResponse(request, {
			'Which layout?': { selected: [OTHER_OPTION_VALUE], otherText: 'A bottom drawer' },
			'Which panels?': { selected: ['Todos'] }
		});

		expect(result.answers['Which layout?']).toBe('A bottom drawer');
	});

	it('rejects multiple selections for a single-choice question', () => {
		expect(() =>
			validateAskUserQuestionResponse(request, {
				'Which layout?': { selected: ['Compact', 'Split'] },
				'Which panels?': { selected: ['Todos'] }
			})
		).toThrow(/single choice/);
	});
});
