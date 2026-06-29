import { Client } from 'pg';

export type ChangeSource<TNotification> = {
	subscribe: (onChange: (notification: TNotification) => void) => Promise<() => Promise<void>>;
};

export function createWake(signal?: AbortSignal, pingMs = 15_000) {
	let wake: (() => void) | null = null;
	let pendingChange = false;

	const notify = () => {
		pendingChange = true;
		wake?.();
	};

	const wait = async (): Promise<'change' | 'ping' | 'abort'> => {
		if (signal?.aborted) return 'abort';
		if (pendingChange) {
			pendingChange = false;
			return 'change';
		}
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				cleanup();
				resolve('ping');
			}, pingMs);
			const onAbort = () => {
				cleanup();
				resolve('abort');
			};
			const cleanup = () => {
				clearTimeout(timer);
				signal?.removeEventListener('abort', onAbort);
				wake = null;
			};
			wake = () => {
				pendingChange = false;
				cleanup();
				resolve('change');
			};
			signal?.addEventListener('abort', onAbort, { once: true });
		});
	};

	return { notify, wait };
}

export function formatNamedSseEvent(event: string, payload: unknown, id?: number): string {
	return `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(
		payload
	)}\n\n`;
}

export function createPgNotificationChangeSource<TNotification>(input: {
	connectionString: string | undefined;
	channel: string;
	missingConnectionMessage: string;
	parseNotification: (payload: string | undefined) => TNotification | null;
}): ChangeSource<TNotification> {
	let client: Client | null = null;
	let connectPromise: Promise<void> | null = null;
	const listeners = new Set<(notification: TNotification) => void>();

	const ensureConnected = async () => {
		if (!input.connectionString) throw new Error(input.missingConnectionMessage);
		if (connectPromise) return connectPromise;
		if (client) return;

		client = new Client({ connectionString: input.connectionString });
		client.on('notification', (message) => {
			if (message.channel !== input.channel) return;
			const notification = input.parseNotification(message.payload);
			if (!notification) return;
			for (const listener of listeners) listener(notification);
		});
		client.on('error', () => {
			client = null;
			connectPromise = null;
		});
		connectPromise = client
			.connect()
			.then(() => client?.query(`LISTEN ${input.channel}`))
			.then(() => undefined)
			.catch(async (error: unknown) => {
				const failedClient = client;
				client = null;
				connectPromise = null;
				await failedClient?.end().catch(() => {});
				throw error;
			});
		await connectPromise;
	};

	const closeIfIdle = async () => {
		if (listeners.size > 0 || !client) return;
		const idleClient = client;
		client = null;
		connectPromise = null;
		try {
			await idleClient.query(`UNLISTEN ${input.channel}`);
		} catch {
			// The connection may already be closed after request abort.
		}
		await idleClient.end().catch(() => {});
	};

	return {
		async subscribe(onChange) {
			listeners.add(onChange);
			try {
				await ensureConnected();
			} catch (error) {
				listeners.delete(onChange);
				throw error;
			}
			return async () => {
				listeners.delete(onChange);
				await closeIfIdle();
			};
		}
	};
}
