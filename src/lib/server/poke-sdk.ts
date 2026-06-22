import {
	Poke,
	getToken,
	isLoggedIn,
	login,
	logout,
	type LoginOptions,
	type LoginResult,
	type SendMessageResponse
} from 'poke';

export async function sendPokeSdkMessage(
	apiKey: string,
	message: string
): Promise<SendMessageResponse> {
	const result = await new Poke({ apiKey }).sendMessage(message);
	if (result.success === false) {
		throw new Error(result.message || 'Poke API returned success=false');
	}
	return result;
}

export function getPokeLocalAuthState(): { loggedIn: boolean; hasToken: boolean } {
	return { loggedIn: isLoggedIn(), hasToken: Boolean(getToken()) };
}

export function getPokeLocalToken(): string | undefined {
	return getToken();
}

export async function loginPokeLocalAccount(options?: LoginOptions): Promise<LoginResult> {
	return await login(options);
}

export async function logoutPokeLocalAccount(): Promise<void> {
	await logout();
}
