import type { RequestHandler } from './$types';
import { error } from '@sveltejs/kit';
import { prisma } from '$lib/server/prisma';
import { requireActiveOrg } from '$lib/server/org';
import { formatSseEvent, parseLastEventIdCursor, streamRunEvents } from '$lib/server/run-stream';

export const GET: RequestHandler = async ({ params, request }) => {
	const runId = params.id;

	const organizationId = await requireActiveOrg(request.headers);
	const run = await prisma.run.findFirst({
		where: { id: runId, organizationId },
		select: { id: true }
	});
	if (!run) error(404, 'Run not found');

	const fromSeq = parseLastEventIdCursor(request.headers);

	const stream = new ReadableStream({
		async start(controller) {
			const enc = new TextEncoder();
			let closed = false;
			const close = () => {
				if (closed) return;
				closed = true;
				try {
					controller.close();
				} catch {
					/* deja ferme */
				}
			};
			request.signal.addEventListener('abort', close);
			try {
				for await (const item of streamRunEvents(runId, { fromSeq, signal: request.signal })) {
					if (closed) break;
					if (item.kind === 'event')
						controller.enqueue(enc.encode(formatSseEvent(item.seq, item.payload)));
					else if (item.kind === 'ping') controller.enqueue(enc.encode(': ping\n\n'));
					else if (item.kind === 'done')
						controller.enqueue(
							enc.encode(`event: done\ndata: ${JSON.stringify({ status: item.status })}\n\n`)
						);
				}
			} finally {
				close();
			}
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-store',
			Connection: 'keep-alive'
		}
	});
};
