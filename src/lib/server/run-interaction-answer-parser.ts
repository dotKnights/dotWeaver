import {
	askUserQuestionRequestSchema,
	OTHER_OPTION_VALUE,
	type AnswerRunInteractionInput
} from '$lib/schemas/run-interactions';

type ParsedAnswer = Pick<AnswerRunInteractionInput, 'answers' | 'response' | 'annotations'>;
type Question = ReturnType<typeof askUserQuestionRequestSchema.parse>['questions'][number];

function normalize(value: string): string {
	return value
		.normalize('NFD')
		.replace(/\p{M}/gu, '')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim()
		.replace(/\s+/g, ' ');
}

function containsLabel(text: string, label: string): boolean {
	const normalizedText = normalize(text);
	const normalizedLabel = normalize(label);
	if (!normalizedText || !normalizedLabel) return false;
	return (
		normalizedText === normalizedLabel ||
		normalizedText.startsWith(`${normalizedLabel} `) ||
		normalizedText.includes(` ${normalizedLabel} `) ||
		normalizedText.endsWith(` ${normalizedLabel}`)
	);
}

function parseLineAnswers(message: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const rawLine of message.split('\n')) {
		const [rawKey, ...rest] = rawLine.split(':');
		const value = rest.join(':').trim();
		if (!rawKey || !value) continue;
		out.set(normalize(rawKey), value);
	}
	return out;
}

function textForQuestion(
	question: Question,
	message: string,
	lineAnswers: Map<string, string>
): string {
	return (
		lineAnswers.get(normalize(question.question)) ??
		lineAnswers.get(normalize(question.header)) ??
		message
	);
}

function selectedForQuestion(
	question: Question,
	text: string
): { selected: string[]; otherText?: string } {
	const matches = question.options
		.filter((option) => containsLabel(text, option.label))
		.map((option) => option.label);

	if (question.multiSelect && matches.length > 0) return { selected: matches };
	if (!question.multiSelect && matches.length === 1) return { selected: [matches[0]] };

	return { selected: [OTHER_OPTION_VALUE], otherText: text };
}

export function parsePokeTextAnswer(requestInput: unknown, messageInput: string): ParsedAnswer {
	const message = messageInput.trim();
	if (!message) throw new Error('A message is required');
	const request = askUserQuestionRequestSchema.parse(requestInput);
	const lineAnswers = parseLineAnswers(message);
	const answers: AnswerRunInteractionInput['answers'] = {};

	for (const question of request.questions) {
		const text = textForQuestion(question, message, lineAnswers).trim();
		answers[question.question] = selectedForQuestion(question, text);
	}

	return {
		answers,
		response: message,
		annotations: { source: { channel: 'poke', parser: 'text' } }
	};
}
