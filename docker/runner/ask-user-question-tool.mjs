import { randomUUID } from 'node:crypto';

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} extra
 * @param {() => string} generateToolUseId
 */
function getToolUseId(extra, generateToolUseId) {
	if (isObject(extra)) {
		for (const key of ['toolUseID', 'toolUseId', 'tool_use_id']) {
			if (typeof extra[key] === 'string' && extra[key].length > 0) return extra[key];
		}
	}

	return generateToolUseId();
}

/**
 * @param {unknown} extra
 */
function getSignal(extra) {
	return isObject(extra) && 'signal' in extra ? extra.signal : undefined;
}

/**
 * @param {{ questions?: unknown }} request
 * @param {{ answers?: unknown, response?: unknown, annotations?: unknown } | null | undefined} response
 */
function serializeAskUserQuestionOutput(request, response) {
	/** @type {{ questions: unknown[], answers: Record<string, unknown>, response?: string, annotations?: unknown }} */
	const output = {
		questions: Array.isArray(request?.questions) ? request.questions : [],
		answers: isObject(response?.answers) ? response.answers : {}
	};

	if (typeof response?.response === 'string') output.response = response.response;
	if (response?.annotations !== undefined) output.annotations = response.annotations;

	return output;
}

/**
 * @param {{
 *   emit: (event: Record<string, unknown>) => void,
 *   waitForInteractionResponse: (toolUseId: string, signal?: unknown) => Promise<{ answers?: unknown, response?: unknown, annotations?: unknown }>,
 *   generateToolUseId?: () => string
 * }} options
 */
export function createAskUserQuestionToolHandler({
	emit,
	waitForInteractionResponse,
	generateToolUseId = randomUUID
}) {
	/**
	 * @param {{ questions?: unknown }} request
	 * @param {unknown} extra
	 */
	return async function handleAskUserQuestion(request, extra) {
		const toolUseId = getToolUseId(extra, generateToolUseId);

		emit({
			type: 'interaction_request',
			kind: 'ask_user_question',
			toolUseId,
			request
		});

		const response = await waitForInteractionResponse(toolUseId, getSignal(extra));
		const structuredContent = serializeAskUserQuestionOutput(request, response);

		return {
			content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
			structuredContent
		};
	};
}
