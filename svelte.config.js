import adapter from '@sveltejs/adapter-node';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true),
		experimental: {
			async: true
		}
	},
	kit: {
		adapter: adapter(),
		// L'app sert un provider OAuth + endpoint MCP (better-auth) consomme par des
		// clients distants (Poke, Claude.ai, MCP Inspector...). L'endpoint token OAuth
		// recoit des POST form-urlencoded cross-origin (origines arbitraires, voire sans
		// header Origin en serveur-a-serveur) : la protection CSRF par origine de SvelteKit
		// les bloque ("Cross-site POST form submissions are forbidden"). On la desactive ;
		// la protection reelle est assuree par better-auth (PKCE + state + trustedOrigins)
		// et les cookies de session SameSite=Lax.
		csrf: {
			trustedOrigins: ['*']
		},
		experimental: {
			remoteFunctions: true
		}
	}
};

export default config;
