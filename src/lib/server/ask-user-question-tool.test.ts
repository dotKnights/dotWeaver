import { describe, expect, it, vi } from 'vitest';

import { createAskUserQuestionToolHandler } from '../../../docker/runner/ask-user-question-tool.mjs';

const request = {
	questions: [
		{
			header: 'Feature cible',
			question: 'Quelle partie veux-tu tester ?',
			multiSelect: false,
			options: [
				{ label: 'Notes', description: 'CRUD notes' },
				{ label: 'Contextes', description: 'Gestion des contextes' }
			]
		}
	]
};

describe('createAskUserQuestionToolHandler', () => {
	it('emits an interaction request and returns the answered AskUserQuestion output', async () => {
		const emit = vi.fn();
		const waitForInteractionResponse = vi.fn().mockResolvedValue({
			answers: { 'Quelle partie veux-tu tester ?': 'Notes' },
			response: 'Je veux tester les notes.'
		});
		const handler = createAskUserQuestionToolHandler({
			emit,
			waitForInteractionResponse,
			generateToolUseId: () => 'generated-id'
		});

		const result = await handler(request, { toolUseID: 'toolu_123', signal: 'signal' });

		expect(emit).toHaveBeenCalledWith({
			type: 'interaction_request',
			kind: 'ask_user_question',
			toolUseId: 'toolu_123',
			request
		});
		expect(waitForInteractionResponse).toHaveBeenCalledWith('toolu_123', 'signal');
		expect(result.structuredContent).toEqual({
			questions: request.questions,
			answers: { 'Quelle partie veux-tu tester ?': 'Notes' },
			response: 'Je veux tester les notes.'
		});
		expect(result.content).toEqual([
			{
				type: 'text',
				text: JSON.stringify(result.structuredContent)
			}
		]);
	});

	it('generates a correlation id when the SDK extra object does not expose one', async () => {
		const emit = vi.fn();
		const waitForInteractionResponse = vi.fn().mockResolvedValue({
			answers: { 'Quelle partie veux-tu tester ?': 'Autre' },
			annotations: { source: 'custom answer' }
		});
		const handler = createAskUserQuestionToolHandler({
			emit,
			waitForInteractionResponse,
			generateToolUseId: () => 'generated-id'
		});

		const result = await handler(request, {});

		expect(emit).toHaveBeenCalledWith(
			expect.objectContaining({
				toolUseId: 'generated-id'
			})
		);
		expect(waitForInteractionResponse).toHaveBeenCalledWith('generated-id', undefined);
		expect(result.structuredContent).toEqual({
			questions: request.questions,
			answers: { 'Quelle partie veux-tu tester ?': 'Autre' },
			annotations: { source: 'custom answer' }
		});
	});
});
