import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import * as z from 'zod/v4';
import { createAskUserQuestionToolHandler } from './ask-user-question-tool.mjs';

const interactionDir = process.env.DOTWEAVER_INTERACTION_DIR;

if (!interactionDir) {
	console.error('DOTWEAVER_INTERACTION_DIR is required');
	process.exit(2);
}

const requestDir = join(interactionDir, 'requests');
const responseDir = join(interactionDir, 'responses');

function interactionFileName(toolUseId) {
	return `${encodeURIComponent(toolUseId)}.json`;
}

async function writeJsonAtomic(path, value) {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tmp, `${JSON.stringify(value)}\n`);
	await rename(tmp, path);
}

async function emitInteractionRequest(event) {
	await writeJsonAtomic(join(requestDir, interactionFileName(event.toolUseId)), event);
}

async function waitForInteractionResponse(toolUseId, signal) {
	const path = join(responseDir, interactionFileName(toolUseId));
	while (true) {
		if (signal?.aborted) {
			throw signal.reason ?? new Error('AskUserQuestion interaction was aborted');
		}
		try {
			const raw = await readFile(path, 'utf8');
			await rm(path, { force: true });
			return JSON.parse(raw);
		} catch (error) {
			if (error?.code !== 'ENOENT') throw error;
		}
		await delay(250, undefined, { signal }).catch((error) => {
			throw error;
		});
	}
}

await mkdir(requestDir, { recursive: true });
await mkdir(responseDir, { recursive: true });

const server = new McpServer({
	name: 'dotweaver',
	version: '1.0.0'
});

const askUserQuestionHandler = createAskUserQuestionToolHandler({
	emit: emitInteractionRequest,
	waitForInteractionResponse
});

server.registerTool(
	'AskUserQuestion',
	{
		description:
			'Ask the user one to four structured questions and wait for their answers before continuing.',
		inputSchema: {
			questions: z
				.array(
					z.object({
						header: z.string().min(1),
						question: z.string().min(1),
						multiSelect: z.boolean(),
						options: z
							.array(
								z.object({
									label: z.string().min(1),
									description: z.string().min(1),
									preview: z.string().optional()
								})
							)
							.min(2)
							.max(4)
					})
				)
				.min(1)
				.max(4)
		}
	},
	askUserQuestionHandler
);

const transport = new StdioServerTransport();
await server.connect(transport);
