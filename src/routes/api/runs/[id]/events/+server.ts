import type { RequestHandler } from './$types';
import { error } from '@sveltejs/kit';
import { auth } from '$lib/server/auth';
import { prisma } from '$lib/server/prisma';
import { resolveActiveOrgId } from '$lib/server/org';
import { formatSseEvent, streamRunEvents } from '$lib/server/run-stream';

export const GET: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session || !locals.user) error(401, 'Not authenticated');
	const runId = params.id;

	const session = await auth.api.getSession({ headers: request.headers });
	let organizationId = '';
	try {
		organizationId = resolveActiveOrgId(session?.session ?? null);
	} catch {
		error(400, 'No active team selected');
	}
	const member = await prisma.member.findFirst({
		where: { organizationId, userId: locals.user.id },
		select: { id: true }
	});
	if (!member) error(403, 'Not a member of the active team');
	const run = await prisma.run.findFirst({
		where: { id: runId, organizationId },
		select: { id: true }
	});
	if (!run) error(404, 'Run not found');

	const lastEventId = Number(request.headers.get('last-event-id'));
	const fromSeq = Number.isFinite(lastEventId) ? lastEventId : -1;

	const stream = new ReadableStream({
		async start(controller) {
			const enc = new TextEncoder();
			let closed = false;
			const close = () => {
				if (closed) return;
				closed = true;
				try { controller.close(); } catch { /* deja ferme */ }
			};
			request.signal.addEventListener('abort', close);
			try {
				for await (const item of streamRunEvents(runId, { fromSeq, signal: request.signal })) {
					if (closed) break;
					if (item.kind === 'event') controller.enqueue(enc.encode(formatSseEvent(item.seq, item.payload)));
					else if (item.kind === 'ping') controller.enqueue(enc.encode(': ping\n\n'));
					else if (item.kind === 'done') controller.enqueue(enc.encode(`event: done\ndata: ${JSON.stringify({ status: item.status })}\n\n`));
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
