import type { RequestHandler } from './$types';
import { error } from '@sveltejs/kit';
import { prisma } from '$lib/server/prisma';
import { requireActiveOrg } from '$lib/server/auth/org';
import { parseLastEventIdCursor } from '$lib/server/runs/stream';
import {
	formatNamedSseEvent,
	streamProjectEnvironmentPrepare
} from '$lib/server/project-environments/stream';

export const GET: RequestHandler = async ({ params, request }) => {
	const projectId = params.id;
	const profileId = params.profileId;
	const organizationId = await requireActiveOrg(request.headers);
	const profile = await prisma.projectEnvironmentProfile.findFirst({
		where: { id: profileId, projectId, organizationId },
		select: { id: true }
	});
	if (!profile) error(404, 'Project environment profile not found');

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
					/* already closed */
				}
			};
			request.signal.addEventListener('abort', close);
			try {
				for await (const item of streamProjectEnvironmentPrepare({
					organizationId,
					projectId,
					profileId,
					fromSeq,
					signal: request.signal
				})) {
					if (closed) break;
					if (item.kind === 'event') {
						controller.enqueue(
							enc.encode(formatNamedSseEvent('prepare_event', item.event, item.seq))
						);
					} else if (item.kind === 'profile') {
						controller.enqueue(enc.encode(formatNamedSseEvent('profile', item.profile)));
					} else {
						controller.enqueue(enc.encode(': ping\n\n'));
					}
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
