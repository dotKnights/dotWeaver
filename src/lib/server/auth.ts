import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { organization, mcp } from 'better-auth/plugins';
import { prisma } from './prisma';
import { env } from '$env/dynamic/private';
import { GMAIL_READONLY_SCOPE } from '$lib/constants/mail';

export const auth = betterAuth({
	baseURL: env.BETTER_AUTH_URL,
	secret: env.BETTER_AUTH_SECRET,
	database: prismaAdapter(prisma, { provider: 'postgresql' }),
	emailAndPassword: {
		enabled: true
	},
	socialProviders: {
		github: {
			clientId: env.GITHUB_CLIENT_ID!,
			clientSecret: env.GITHUB_CLIENT_SECRET!,
			scope: ['repo']
		},
		google: {
			clientId: env.GOOGLE_CLIENT_ID!,
			clientSecret: env.GOOGLE_CLIENT_SECRET!,
			scope: ['openid', 'email', 'profile', GMAIL_READONLY_SCOPE],
			accessType: 'offline',
			prompt: 'select_account consent'
		}
	},
	account: {
		enabled: true,
		encryptOAuthTokens: true,
		accountLinking: {
			enabled: true,
			trustedProviders: ['github', 'google']
		}
	},
	plugins: [
		organization(),
		mcp({
			loginPage: '/login',
			resource: new URL('/mcp', env.BETTER_AUTH_URL).toString()
		})
	]
});
