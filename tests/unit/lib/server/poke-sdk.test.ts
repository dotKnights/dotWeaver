import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	sendMessage: vi.fn(),
	Poke: vi.fn(),
	login: vi.fn(),
	logout: vi.fn()
}));

vi.mock('poke', () => ({
	Poke: class {
		constructor(options: unknown) {
			mocks.Poke(options);
			return { sendMessage: mocks.sendMessage };
		}
	},
	login: mocks.login,
	logout: mocks.logout
}));

import {
	loginPokeLocalAccount,
	logoutPokeLocalAccount,
	sendPokeSdkMessage
} from '$lib/server/poke-sdk';

describe('poke-sdk', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.logout.mockResolvedValue(undefined);
	});

	it('sends messages through the official SDK with an explicit user credential', async () => {
		mocks.sendMessage.mockResolvedValue({ success: true, message: 'sent' });

		await expect(sendPokeSdkMessage('user-key', 'hello')).resolves.toEqual({
			success: true,
			message: 'sent'
		});

		expect(mocks.Poke).toHaveBeenCalledWith({ apiKey: 'user-key' });
		expect(mocks.sendMessage).toHaveBeenCalledWith('hello');
	});

	it('turns SDK success=false responses into errors', async () => {
		mocks.sendMessage.mockResolvedValue({ success: false, message: 'blocked' });

		await expect(sendPokeSdkMessage('user-key', 'hello')).rejects.toThrow('blocked');
	});

	it('wraps the SDK login and logout helpers', async () => {
		mocks.login.mockResolvedValue({ token: 'local-token' });
		mocks.logout.mockResolvedValue(undefined);

		await expect(loginPokeLocalAccount({ openBrowser: false })).resolves.toEqual({
			token: 'local-token'
		});
		await expect(logoutPokeLocalAccount()).resolves.toBeUndefined();
	});
});
