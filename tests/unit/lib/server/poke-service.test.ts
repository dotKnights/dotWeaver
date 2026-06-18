import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	findUnique: vi.fn(),
	upsert: vi.fn(),
	updateMany: vi.fn(),
	deleteMany: vi.fn(),
	privateEnv: { PROJECT_SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64') }
}));

vi.mock('$env/dynamic/private', () => ({ env: mocks.privateEnv }));
vi.mock('$lib/server/prisma', () => ({
	prisma: {
		userPokeConfig: {
			findUnique: mocks.findUnique,
			upsert: mocks.upsert,
			updateMany: mocks.updateMany,
			deleteMany: mocks.deleteMany
		}
	}
}));

import {
	deleteUserPokeConfig,
	getUserPokeConfig,
	PokeConfigError,
	sendPokeQuestionNotification,
	upsertUserPokeApiKey
} from '$lib/server/poke-service';
import { decryptProjectSecretValue } from '$lib/server/project-agent-config-encryption';

const request = {
	questions: [
		{
			header: 'Layout',
			question: 'Which layout?',
			multiSelect: false,
			options: [
				{ label: 'Compact', description: 'Dense view' },
				{ label: 'Split', description: 'Two panels' }
			]
		}
	]
};

describe('poke-service', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns a masked disconnected state when no config exists', async () => {
		mocks.findUnique.mockResolvedValue(null);

		await expect(getUserPokeConfig('u1')).resolves.toEqual({
			connected: false,
			enabled: false,
			lastNotifiedAt: null,
			lastError: null
		});
	});

	it('upserts an encrypted api key and returns masked connected state', async () => {
		mocks.upsert.mockImplementation(async ({ create }) => ({
			userId: create.userId,
			apiKeyEncrypted: create.apiKeyEncrypted,
			enabled: true,
			lastNotifiedAt: null,
			lastError: null
		}));

		const result = await upsertUserPokeApiKey('u1', ' pk_live ');
		const encrypted = mocks.upsert.mock.calls[0][0].create.apiKeyEncrypted;

		expect(decryptProjectSecretValue(encrypted)).toBe('pk_live');
		expect(result).toEqual({
			connected: true,
			enabled: true,
			lastNotifiedAt: null,
			lastError: null
		});
		expect(JSON.stringify(result)).not.toContain('pk_live');
	});

	it('rejects an empty api key', async () => {
		await expect(upsertUserPokeApiKey('u1', '   ')).rejects.toBeInstanceOf(PokeConfigError);
		expect(mocks.upsert).not.toHaveBeenCalled();
	});

	it('deletes a user config', async () => {
		mocks.deleteMany.mockResolvedValue({ count: 1 });

		await expect(deleteUserPokeConfig('u1')).resolves.toEqual({
			connected: false,
			enabled: false,
			lastNotifiedAt: null,
			lastError: null
		});
		expect(mocks.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
	});

	it('sends a Poke notification with the bearer api key and marks success', async () => {
		const now = new Date('2026-06-18T10:00:00.000Z');
		vi.useFakeTimers();
		vi.setSystemTime(now);
		const { encryptProjectSecretValue } =
			await import('$lib/server/project-agent-config-encryption');
		mocks.findUnique.mockResolvedValue({
			userId: 'u1',
			apiKeyEncrypted: encryptProjectSecretValue('poke-key'),
			enabled: true
		});
		mocks.updateMany.mockResolvedValue({ count: 1 });
		const fetchImpl = vi.fn().mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue({ success: true })
		});

		const result = await sendPokeQuestionNotification({
			userId: 'u1',
			runId: 'r1',
			interactionId: 'i1',
			projectLabel: 'acme/repo',
			request,
			fetchImpl
		});

		expect(result).toEqual({ sent: true });
		expect(fetchImpl).toHaveBeenCalledWith(
			'https://poke.com/api/v1/inbound/api-message',
			expect.objectContaining({
				method: 'POST',
				headers: expect.objectContaining({ Authorization: 'Bearer poke-key' })
			})
		);
		expect(JSON.parse(fetchImpl.mock.calls[0][1].body).message).toContain(
			'answer_pending_question'
		);
		expect(mocks.updateMany).toHaveBeenCalledWith({
			where: { userId: 'u1' },
			data: { lastNotifiedAt: now, lastError: null }
		});
		vi.useRealTimers();
	});

	it('stores the last notification error and does not throw on Poke failure', async () => {
		const { encryptProjectSecretValue } =
			await import('$lib/server/project-agent-config-encryption');
		mocks.findUnique.mockResolvedValue({
			userId: 'u1',
			apiKeyEncrypted: encryptProjectSecretValue('poke-key'),
			enabled: true
		});
		mocks.updateMany.mockResolvedValue({ count: 1 });
		const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401, text: vi.fn() });

		const result = await sendPokeQuestionNotification({
			userId: 'u1',
			runId: 'r1',
			interactionId: 'i1',
			projectLabel: 'acme/repo',
			request,
			fetchImpl
		});

		expect(result).toEqual({ sent: false, error: 'Poke API returned 401' });
		expect(mocks.updateMany).toHaveBeenCalledWith({
			where: { userId: 'u1' },
			data: { lastError: 'Poke API returned 401' }
		});
	});
});
