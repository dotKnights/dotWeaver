import { describe, expect, it } from 'vitest';
import { OTHER_OPTION_VALUE } from '$lib/schemas/run-interactions';
import { parsePokeTextAnswer } from '$lib/server/run-interaction-answer-parser';

const request = {
	questions: [
		{
			header: 'Layout',
			question: 'Which layout?',
			multiSelect: false,
			options: [
				{ label: 'Compact', description: 'Dense view' },
				{ label: 'Split', description: 'Two panels' }
			]
		}
	]
};

describe('parsePokeTextAnswer', () => {
	it('matches an exact single-choice option label', () => {
		expect(parsePokeTextAnswer(request, 'Compact')).toMatchObject({
			answers: { 'Which layout?': { selected: ['Compact'] } },
			response: 'Compact'
		});
	});

	it('matches a single-choice option ignoring case and punctuation', () => {
		expect(parsePokeTextAnswer(request, 'compact!')).toMatchObject({
			answers: { 'Which layout?': { selected: ['Compact'] } },
			response: 'compact!'
		});
	});

	it('falls back to Other with the original text when no option matches', () => {
		expect(parsePokeTextAnswer(request, 'Use the mobile layout')).toMatchObject({
			answers: {
				'Which layout?': { selected: [OTHER_OPTION_VALUE], otherText: 'Use the mobile layout' }
			}
		});
	});

	it('parses multiple questions from Header lines', () => {
		const multiRequest = {
			questions: [
				...request.questions,
				{
					header: 'Tone',
					question: 'Which tone?',
					multiSelect: false,
					options: [
						{ label: 'Calm', description: 'Quiet copy' },
						{ label: 'Bold', description: 'Punchy copy' }
					]
				}
			]
		};

		expect(parsePokeTextAnswer(multiRequest, 'Layout: Split\nTone: Bold')).toMatchObject({
			answers: {
				'Which layout?': { selected: ['Split'] },
				'Which tone?': { selected: ['Bold'] }
			}
		});
	});

	it('parses multiple questions from Question lines', () => {
		const multiRequest = {
			questions: [
				...request.questions,
				{
					header: 'Tone',
					question: 'Which tone?',
					multiSelect: false,
					options: [
						{ label: 'Calm', description: 'Quiet copy' },
						{ label: 'Bold', description: 'Punchy copy' }
					]
				}
			]
		};

		expect(
			parsePokeTextAnswer(multiRequest, 'Which layout?: Split\nWhich tone?: Bold')
		).toMatchObject({
			answers: {
				'Which layout?': { selected: ['Split'] },
				'Which tone?': { selected: ['Bold'] }
			}
		});
	});

	it('selects every mentioned option for multi-select questions', () => {
		const multiSelectRequest = {
			questions: [
				{
					header: 'Channels',
					question: 'Which channels?',
					multiSelect: true,
					options: [
						{ label: 'Email', description: 'Email updates' },
						{ label: 'SMS', description: 'Text messages' },
						{ label: 'Push', description: 'Push notifications' }
					]
				}
			]
		};

		expect(parsePokeTextAnswer(multiSelectRequest, 'Email and push')).toMatchObject({
			answers: { 'Which channels?': { selected: ['Email', 'Push'] } }
		});
	});
});
