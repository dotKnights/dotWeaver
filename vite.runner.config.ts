// Config Vite minimale pour exécuter le worker (`src/runner`) via vite-node.
//
// On N'INCLUT PAS le plugin SvelteKit : hors d'un vrai build Kit il lève
// « An impossible situation occurred ». Le worker n'a besoin que de l'alias `$lib`
// et d'un shim pour `$env/dynamic/private` (le seul module Kit dans son graphe, via
// `src/lib/server/prisma.ts`). `bun run` charge déjà `.env` dans `process.env`.
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
	resolve: {
		alias: {
			$lib: fileURLToPath(new URL('./src/lib', import.meta.url))
		}
	},
	plugins: [
		{
			name: 'env-dynamic-private-shim',
			resolveId(id) {
				if (id === '$env/dynamic/private') return '\0env-dynamic-private-shim';
			},
			load(id) {
				if (id === '\0env-dynamic-private-shim') return 'export const env = process.env;';
			}
		}
	]
});
