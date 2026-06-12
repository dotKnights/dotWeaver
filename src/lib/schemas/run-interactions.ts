import { z } from 'zod';

export const OTHER_OPTION_VALUE = '__other__';

const askUserOptionSchema = z
	.object({
		label: z.string().min(1),
		description: z.string().min(1),
		preview: z.string().optional()
	})
	.passthrough();

const askUserQuestionItemSchema = z
	.object({
		question: z.string().min(1),
		header: z.string().min(1),
		options: z.array(askUserOptionSchema).min(2).max(4),
		multiSelect: z.boolean()
	})
	.passthrough();

export const askUserQuestionRequestSchema = z
	.object({
		questions: z.array(askUserQuestionItemSchema).min(1).max(4)
	})
	.passthrough();

export type AskUserQuestionRequest = z.infer<typeof askUserQuestionRequestSchema>;

export const questionAnswerSchema = z.object({
	selected: z.array(z.string().min(1)).min(1),
	otherText: z.string().optional()
});

export const answerRunInteractionSchema = z.object({
	interactionId: z.string().min(1),
	answers: z.record(z.string().min(1), questionAnswerSchema),
	response: z.string().optional(),
	annotations: z.record(z.string(), z.record(z.string(), z.unknown())).optional()
});

export type AnswerRunInteractionInput = z.infer<typeof answerRunInteractionSchema>;

export interface SerializedAskUserQuestionResponse {
	answers: Record<string, string>;
	response?: string;
	annotations?: Record<string, unknown>;
}

function requireOtherText(question: string, otherText: string | undefined): string {
	const trimmed = otherText?.trim() ?? '';
	if (!trimmed) throw new Error(`Other answer is required for "${question}"`);
	return trimmed;
}

export function validateAskUserQuestionResponse(
	requestInput: unknown,
	answersInput: AnswerRunInteractionInput['answers'],
	response?: string,
	annotations?: AnswerRunInteractionInput['annotations']
): SerializedAskUserQuestionResponse {
	const request = askUserQuestionRequestSchema.parse(requestInput);
	const out: Record<string, string> = {};

	for (const question of request.questions) {
		const answer = answersInput[question.question];
		if (!answer) throw new Error(`Answer required for "${question.question}"`);

		if (!question.multiSelect && answer.selected.length !== 1) {
			throw new Error(`"${question.question}" is a single choice question`);
		}

		const validLabels = new Set(question.options.map((option) => option.label));
		const values: string[] = [];

		for (const selected of answer.selected) {
			if (selected === OTHER_OPTION_VALUE) {
				values.push(requireOtherText(question.question, answer.otherText));
			} else if (validLabels.has(selected)) {
				values.push(selected);
			} else {
				throw new Error(`Invalid answer "${selected}" for "${question.question}"`);
			}
		}

		out[question.question] = values.join(', ');
	}

	return {
		answers: out,
		...(response?.trim() ? { response: response.trim() } : {}),
		...(annotations ? { annotations } : {})
	};
}
