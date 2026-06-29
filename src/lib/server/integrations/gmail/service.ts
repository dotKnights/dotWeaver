import { Prisma, type MailSyncState } from '@prisma/client';
import { DEFAULT_MAIL_QUERY, MAIL_WINDOW_DAYS } from '$lib/constants/mail';
import {
	getGmailThread,
	listGmailThreadsPage,
	mapGmailThreadToMailThread,
	normalizeGmailError
} from './client';
import { prisma } from '$lib/server/prisma';

export const SYNC_PAGE_SIZE = 25;
export const INDEXED_THREAD_LIMIT = 500;
const INTERNAL_SYNC_ERROR = 'Unable to sync mail right now.';
const NORMALIZED_GMAIL_SYNC_ERROR = Symbol('normalizedGmailSyncError');

export type NormalizedGmailSyncError = Error & {
	kind: ReturnType<typeof normalizeGmailError>['kind'];
	[NORMALIZED_GMAIL_SYNC_ERROR]: true;
};

type MailSyncClaim =
	| { claimed: true; state: MailSyncState }
	| { claimed: false; state: MailSyncState | null };

export function listIndexedMailThreads(userId: string) {
	return prisma.mailThread.findMany({
		where: { userId },
		orderBy: { lastMessageAt: 'desc' },
		take: INDEXED_THREAD_LIMIT
	});
}

export async function syncNextMailPage(userId: string, accessToken: string) {
	const indexedThreadCount = await prisma.mailThread.count({ where: { userId } });
	if (indexedThreadCount >= INDEXED_THREAD_LIMIT) {
		const state = await prisma.mailSyncState.findUnique({ where: { userId } });
		return {
			synced: 0,
			hasMore: false,
			nextPageToken: state?.nextPageToken ?? null
		};
	}

	const claim = await claimMailSyncState(userId);
	if (!claim.claimed) {
		return {
			synced: 0,
			hasMore: Boolean(claim.state?.nextPageToken),
			nextPageToken: claim.state?.nextPageToken ?? null
		};
	}

	const { state } = claim;

	try {
		const page = await withNormalizedGmailError(userId, state.nextPageToken, () =>
			listGmailThreadsPage(accessToken, {
				query: state.query || DEFAULT_MAIL_QUERY,
				pageToken: state.nextPageToken,
				maxResults: SYNC_PAGE_SIZE
			})
		);

		let synced = 0;
		for (const threadRef of page.threads ?? []) {
			const gmailThread = await withNormalizedGmailError(userId, state.nextPageToken, () =>
				getGmailThread(accessToken, threadRef.id, 'metadata')
			);
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

		await prisma.mailSyncState.updateMany({
			where: { userId, nextPageToken: state.nextPageToken, status: 'syncing' },
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
		if (isNormalizedGmailSyncError(error)) throw error;

		await prisma.mailSyncState.updateMany({
			where: { userId, nextPageToken: state.nextPageToken, status: 'syncing' },
			data: { status: 'error', error: INTERNAL_SYNC_ERROR }
		});
		throw error;
	}
}

export function getMailSyncState(userId: string) {
	return prisma.mailSyncState.findUnique({ where: { userId } });
}

async function claimMailSyncState(userId: string): Promise<MailSyncClaim> {
	const existing = await prisma.mailSyncState.findUnique({ where: { userId } });
	if (!existing) {
		try {
			return {
				claimed: true,
				state: await prisma.mailSyncState.create({
					data: {
						userId,
						query: DEFAULT_MAIL_QUERY,
						windowDays: MAIL_WINDOW_DAYS,
						status: 'syncing'
					}
				})
			};
		} catch (error) {
			if (!isPrismaUniqueConstraintError(error)) throw error;
			return {
				claimed: false,
				state: await prisma.mailSyncState.findUnique({ where: { userId } })
			};
		}
	}

	if (existing.status === 'syncing') return { claimed: false, state: existing };

	const claim = await prisma.mailSyncState.updateMany({
		where: { userId, status: existing.status, nextPageToken: existing.nextPageToken },
		data: { status: 'syncing', error: null }
	});
	if (claim.count === 0) {
		return {
			claimed: false,
			state: await prisma.mailSyncState.findUnique({ where: { userId } })
		};
	}

	return { claimed: true, state: existing };
}

async function withNormalizedGmailError<T>(
	userId: string,
	nextPageToken: string | null,
	operation: () => Promise<T>
): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		const normalized = normalizeGmailError(error);
		await prisma.mailSyncState.updateMany({
			where: { userId, nextPageToken, status: 'syncing' },
			data: { status: 'error', error: normalized.message }
		});
		throw Object.assign(new Error(normalized.message), {
			kind: normalized.kind,
			[NORMALIZED_GMAIL_SYNC_ERROR]: true
		}) as NormalizedGmailSyncError;
	}
}

export function isNormalizedGmailSyncError(error: unknown): error is NormalizedGmailSyncError {
	return (
		typeof error === 'object' &&
		error !== null &&
		(error as Partial<NormalizedGmailSyncError>)[NORMALIZED_GMAIL_SYNC_ERROR] === true
	);
}

function isPrismaUniqueConstraintError(error: unknown): boolean {
	if (error instanceof Prisma.PrismaClientKnownRequestError) {
		return error.code === 'P2002';
	}
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		(error as { code?: unknown }).code === 'P2002'
	);
}
