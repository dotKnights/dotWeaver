import { command, getRequestEvent, query } from '$app/server';
import { error } from '@sveltejs/kit';
import { z } from 'zod';
import {
	deleteUserPokeConfig,
	getUserPokeConfig,
	getUserPokeLoginState,
	PokeConfigError,
	setUserPokeEnabled,
	startUserPokeLogin
} from '$lib/server/integrations/poke/service';

function requireUserId(): string {
	const { locals } = getRequestEvent();
	const userId = locals.user?.id;
	if (!userId) error(401, 'Not authenticated');
	return userId;
}

function mapPokeError(e: unknown): never {
	if (e instanceof PokeConfigError) error(400, e.message);
	throw e;
}

export const getPokeConnector = query(async () => {
	return await getUserPokeConfig(requireUserId());
});

export const getPokeLoginState = query(async () => {
	return await getUserPokeLoginState(requireUserId());
});

export const setPokeEnabled = command(z.object({ enabled: z.boolean() }), async ({ enabled }) => {
	try {
		const result = await setUserPokeEnabled(requireUserId(), enabled);
		await getPokeConnector().refresh();
		return result;
	} catch (e) {
		mapPokeError(e);
	}
});

export const startPokeLogin = command(async () => {
	try {
		const result = await startUserPokeLogin(requireUserId());
		await getPokeConnector().refresh();
		await getPokeLoginState().refresh();
		return result;
	} catch (e) {
		mapPokeError(e);
	}
});

export const deletePokeConnector = command(async () => {
	const result = await deleteUserPokeConfig(requireUserId());
	await getPokeConnector().refresh();
	await getPokeLoginState().refresh();
	return result;
});
