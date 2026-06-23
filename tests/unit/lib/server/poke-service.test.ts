import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	findUnique: vi.fn(),
	upsert: vi.fn(),
	updateMany: vi.fn(),
	deleteMany: vi.fn(),
	sendPokeSdkMessage: vi.fn(),
	loginPokeLocalAccount: vi.fn(),
	logoutPokeLocalAccount: vi.fn(),
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
vi.mock('$lib/server/poke-sdk', () => ({
	loginPokeLocalAccount: mocks.loginPokeLocalAccount,
	logoutPokeLocalAccount: mocks.logoutPokeLocalAccount,
	sendPokeSdkMessage: mocks.sendPokeSdkMessage
}));

import {
	cancelUserPokeLogin,
	deleteUserPokeConfig,
	getUserPokeLoginState,
	getUserPokeConfig,
	sendPokeQuestionNotification,
	startUserPokeLogin
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
		vi.resetAllMocks();
		mocks.findUnique.mockResolvedValue(null);
		mocks.logoutPokeLocalAccount.mockResolvedValue(undefined);
		cancelUserPokeLogin('u1');
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

	it('stores the SDK login token encrypted and returns masked connected state', async () => {
		mocks.upsert.mockImplementation(async ({ create }) => ({
			userId: create.userId,
			credentialEncrypted: create.credentialEncrypted,
			enabled: true,
			lastNotifiedAt: null,
			lastError: null
		}));
		mocks.logoutPokeLocalAccount.mockResolvedValue(undefined);
		mocks.loginPokeLocalAccount.mockImplementation(async ({ onCode }) => {
			onCode?.({
				userCode: 'ABCD-1234',
				loginUrl: 'https://poke.com/device?code=ABCD-1234'
			});
			return { token: 'sdk-login-token' };
		});

		const state = await startUserPokeLogin('u1');

		expect(state).toEqual({
			status: 'pending',
			loggedIn: false,
			userCode: 'ABCD-1234',
			loginUrl: 'https://poke.com/device?code=ABCD-1234'
		});
		await vi.waitFor(() => expect(mocks.upsert).toHaveBeenCalled());
		const encrypted = mocks.upsert.mock.calls[0][0].create.credentialEncrypted;

		expect(decryptProjectSecretValue(encrypted)).toBe('sdk-login-token');
		await vi.waitFor(async () =>
			expect(await getUserPokeLoginState('u1')).toEqual({ status: 'connected', loggedIn: true })
		);
		expect(mocks.upsert.mock.calls[0][0]).toMatchObject({
			where: { userId: 'u1' },
			create: { userId: 'u1', enabled: true, lastError: null },
			update: { enabled: true, lastError: null },
			select: { enabled: true, lastNotifiedAt: true, lastError: true }
		});
		expect(JSON.stringify(state)).not.toContain('sdk-login-token');
	});

	it('returns connected immediately when starting login for an already connected user', async () => {
		mocks.findUnique.mockResolvedValue({
			enabled: true,
			lastNotifiedAt: null,
			lastError: null
		});

		await expect(startUserPokeLogin('u1')).resolves.toEqual({
			loggedIn: true,
			status: 'connected'
		});

		expect(mocks.loginPokeLocalAccount).not.toHaveBeenCalled();
	});

	it('captures SDK login errors for the UI', async () => {
		mocks.logoutPokeLocalAccount.mockResolvedValue(undefined);
		mocks.loginPokeLocalAccount.mockRejectedValue(new Error('Login timed out.'));

		await expect(startUserPokeLogin('u1')).resolves.toEqual({
			status: 'failed',
			loggedIn: false,
			error: 'Login timed out.'
		});
		expect(await getUserPokeLoginState('u1')).toEqual({
			status: 'failed',
			loggedIn: false,
			error: 'Login timed out.'
		});
	});

	it('dedupes concurrent SDK login starts for the same user', async () => {
		let emitCode!: (info: { userCode: string; loginUrl: string }) => void;
		let resolveLogin!: (result: { token: string }) => void;
		mocks.loginPokeLocalAccount.mockImplementation(
			({ onCode }) =>
				new Promise((resolve) => {
					emitCode = onCode;
					resolveLogin = resolve;
				})
		);
		mocks.upsert.mockImplementation(async ({ create }) => ({
			userId: create.userId,
			credentialEncrypted: create.credentialEncrypted,
			enabled: true,
			lastNotifiedAt: null,
			lastError: null
		}));

		const first = startUserPokeLogin('u1');
		const second = startUserPokeLogin('u1');
		await vi.waitFor(() => expect(mocks.loginPokeLocalAccount).toHaveBeenCalledTimes(1));
		emitCode({
			userCode: 'ABCD-1234',
			loginUrl: 'https://poke.com/device?code=ABCD-1234'
		});

		await expect(first).resolves.toEqual({
			status: 'pending',
			loggedIn: false,
			userCode: 'ABCD-1234',
			loginUrl: 'https://poke.com/device?code=ABCD-1234'
		});
		await expect(second).resolves.toEqual({
			status: 'pending',
			loggedIn: false,
			userCode: 'ABCD-1234',
			loginUrl: 'https://poke.com/device?code=ABCD-1234'
		});
		resolveLogin({ token: 'sdk-login-token' });
		await vi.waitFor(() => expect(mocks.upsert).toHaveBeenCalled());
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
		expect(await getUserPokeLoginState('u1')).toEqual({ status: 'idle', loggedIn: false });
	});

	it('sends a Poke notification with the encrypted SDK credential and marks success', async () => {
		const now = new Date('2026-06-18T10:00:00.000Z');
		vi.useFakeTimers();
		vi.setSystemTime(now);
		const { encryptProjectSecretValue } =
			await import('$lib/server/project-agent-config-encryption');
		mocks.findUnique.mockResolvedValue({
			userId: 'u1',
			credentialEncrypted: encryptProjectSecretValue('sdk-login-token'),
			enabled: true
		});
		mocks.updateMany.mockResolvedValue({ count: 1 });
		mocks.sendPokeSdkMessage.mockResolvedValue({ success: true, message: 'Message sent' });

		const result = await sendPokeQuestionNotification({
			userId: 'u1',
			runId: 'r1',
			interactionId: 'i1',
			projectLabel: 'acme/repo',
			request
		});

		expect(result).toEqual({ sent: true });
		expect(mocks.sendPokeSdkMessage).toHaveBeenCalledWith(
			'sdk-login-token',
			expect.stringContaining('answer_pending_question')
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
			credentialEncrypted: encryptProjectSecretValue('sdk-login-token'),
			enabled: true
		});
		mocks.updateMany.mockResolvedValue({ count: 1 });
		mocks.sendPokeSdkMessage.mockRejectedValue(new Error('Poke: Invalid API key'));

		const result = await sendPokeQuestionNotification({
			userId: 'u1',
			runId: 'r1',
			interactionId: 'i1',
			projectLabel: 'acme/repo',
			request
		});

		expect(result).toEqual({ sent: false, error: 'Poke: Invalid API key' });
		expect(mocks.updateMany).toHaveBeenCalledWith({
			where: { userId: 'u1' },
			data: { lastError: 'Poke: Invalid API key' }
		});
	});
});
