import { error } from '@sveltejs/kit';
import { getRequestEvent } from '$app/server';

export function requireHeaders() {
	const { request, locals } = getRequestEvent();
	if (!locals.session) error(401, 'Not authenticated');
	return request.headers;
}
