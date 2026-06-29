import {
	Poke,
	login,
	logout,
	type LoginOptions,
	type LoginResult,
	type SendMessageResponse
} from 'poke';

export async function sendPokeSdkMessage(
	credential: string,
	message: string
): Promise<SendMessageResponse> {
	const result = await new Poke({ apiKey: credential }).sendMessage(message);
	if (result.success === false) {
		throw new Error(result.message || 'Poke API returned success=false');
	}
	return result;
}

export async function loginPokeLocalAccount(options?: LoginOptions): Promise<LoginResult> {
	return await login(options);
}

export async function logoutPokeLocalAccount(): Promise<void> {
	await logout();
}
