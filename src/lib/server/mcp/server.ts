import { createMcpHandler } from 'mcp-handler';
import { registerTools } from '$lib/server/mcp/tools';

/**
 * Construit un handler fetch MCP (Streamable HTTP) scope a un utilisateur.
 * Recree par requete en fermant sur la session - cout negligeable en process
 * persistant (adapter-node) et evite tout AsyncLocalStorage.
 *
 * On ne passe pas de basePath car le default streamableHttpEndpoint est deja
 * "/mcp", ce qui correspond au pathname de la route SvelteKit /mcp.
 */
export function createDotweaverMcpHandler(userId: string): (req: Request) => Promise<Response> {
	return createMcpHandler(
		(server) => {
			registerTools(server, { userId });
		},
		{},
		{}
	);
}
