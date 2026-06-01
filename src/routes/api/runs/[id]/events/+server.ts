import type { RequestHandler } from './$types';
import { error } from '@sveltejs/kit';
import { auth } from '$lib/server/auth';
import { prisma } from '$lib/server/prisma';
import { resolveActiveOrgId } from '$lib/server/org';
import { formatSseEvent, isTerminalStatus } from '$lib/server/run-stream';

const POLL_MS = 1000;
const PING_EVERY = 15;

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
	let cursor = Number.isFinite(lastEventId) ? lastEventId : -1;

	const stream = new ReadableStream({
		async start(controller) {
			const enc = new TextEncoder();
			let closed = false;
			const send = (s: string) => {
				if (!closed) controller.enqueue(enc.encode(s));
			};
			const close = () => {
				if (closed) return;
				closed = true;
				try {
					controller.close();
				} catch {
					// déjà fermé
				}
			};
			request.signal.addEventListener('abort', close);

			let tick = 0;
			while (!closed) {
				const events = await prisma.runEvent.findMany({
					where: { runId, seq: { gt: cursor } },
					orderBy: { seq: 'asc' }
				});
				for (const ev of events) {
					send(formatSseEvent(ev.seq, ev.payload));
					cursor = ev.seq;
				}
				const current = await prisma.run.findUnique({
					where: { id: runId },
					select: { status: true }
				});
				if (current && isTerminalStatus(current.status)) {
					send(`event: done\ndata: ${JSON.stringify({ status: current.status })}\n\n`);
					break;
				}
				if (++tick % PING_EVERY === 0) send(': ping\n\n');
				await new Promise((r) => setTimeout(r, POLL_MS));
			}
			close();
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
