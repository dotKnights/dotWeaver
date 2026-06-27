import type { RequestHandler } from './$types';
import { error } from '@sveltejs/kit';
import { requireActiveOrg } from '$lib/server/org';
import {
	ProjectEnvironmentServiceError,
	requireProjectEnvironmentServiceForOrg
} from '$lib/server/project-environment-services/service';
import {
	formatNamedSseEvent,
	streamProjectEnvironmentServiceEvents
} from '$lib/server/project-environment-services/stream';
import { parseLastEventIdCursor } from '$lib/server/run-stream';

export const GET: RequestHandler = async ({ params, request }) => {
	const projectId = params.id;
	const serviceId = params.serviceId;
	const organizationId = await requireActiveOrg(request.headers);
	let service: Awaited<ReturnType<typeof requireProjectEnvironmentServiceForOrg>>;
	try {
		service = await requireProjectEnvironmentServiceForOrg(organizationId, projectId, serviceId);
	} catch (err) {
		if (err instanceof ProjectEnvironmentServiceError) {
			error(404, 'Project environment service not found');
		}
		throw err;
	}

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
				for await (const item of streamProjectEnvironmentServiceEvents({
					organizationId,
					projectId,
					profileId: service.profileId,
					serviceId,
					fromSeq,
					signal: request.signal
				})) {
					if (closed) break;
					if (item.kind === 'event') {
						controller.enqueue(
							enc.encode(formatNamedSseEvent('service_event', item.event, item.seq))
						);
					} else if (item.kind === 'service') {
						controller.enqueue(enc.encode(formatNamedSseEvent('service', item.service)));
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
