import { DEFAULT_MAIL_QUERY, MAIL_WINDOW_DAYS } from '$lib/constants/mail';
import {
	getGmailThread,
	listGmailThreadsPage,
	mapGmailThreadToMailThread,
	normalizeGmailError
} from '$lib/server/gmail';
import { prisma } from '$lib/server/prisma';

const PAGE_SIZE = 25;

export function listIndexedMailThreads(userId: string) {
	return prisma.mailThread.findMany({
		where: { userId },
		orderBy: { lastMessageAt: 'desc' },
		take: 50
	});
}

export async function syncNextMailPage(userId: string, accessToken: string) {
	const state = await prisma.mailSyncState.upsert({
		where: { userId },
		create: {
			userId,
			query: DEFAULT_MAIL_QUERY,
			windowDays: MAIL_WINDOW_DAYS,
			status: 'syncing'
		},
		update: { status: 'syncing', error: null }
	});

	try {
		const page = await listGmailThreadsPage(accessToken, {
			query: state.query || DEFAULT_MAIL_QUERY,
			pageToken: state.nextPageToken,
			maxResults: PAGE_SIZE
		});

		let synced = 0;
		for (const threadRef of page.threads ?? []) {
			const gmailThread = await getGmailThread(accessToken, threadRef.id, 'metadata');
			if (!gmailThread.messages?.length) continue;

			const mapped = mapGmailThreadToMailThread(userId, gmailThread);
			await prisma.mailThread.upsert({
				where: { userId_gmailThreadId: { userId, gmailThreadId: mapped.gmailThreadId } },
				create: mapped,
				update: {
					historyId: mapped.historyId,
					subject: mapped.subject,
					snippet: mapped.snippet,
					participants: mapped.participants,
					fromEmail: mapped.fromEmail,
					fromName: mapped.fromName,
					toEmails: mapped.toEmails,
					labelIds: mapped.labelIds,
					lastMessageAt: mapped.lastMessageAt,
					messageCount: mapped.messageCount,
					unread: mapped.unread,
					starred: mapped.starred
				}
			});
			synced += 1;
		}

		await prisma.mailSyncState.update({
			where: { userId },
			data: {
				nextPageToken: page.nextPageToken ?? null,
				lastSyncedAt: new Date(),
				status: 'idle',
				error: null
			}
		});

		return {
			synced,
			hasMore: Boolean(page.nextPageToken),
			nextPageToken: page.nextPageToken ?? null
		};
	} catch (error) {
		const normalized = normalizeGmailError(error);
		await prisma.mailSyncState.update({
			where: { userId },
			data: { status: 'error', error: normalized.message }
		});
		throw Object.assign(new Error(normalized.message), { kind: normalized.kind });
	}
}

export function getMailSyncState(userId: string) {
	return prisma.mailSyncState.findUnique({ where: { userId } });
}
