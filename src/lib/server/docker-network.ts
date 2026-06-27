import { spawn } from 'node:child_process';

export const DEFAULT_RUNNER_NETWORK = 'dotweaver-runner';

const BUILT_IN_NETWORKS = new Set(['bridge', 'host', 'none']);

export function resolveRunnerNetwork(value: string | undefined | null): string {
	const trimmed = value?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_RUNNER_NETWORK;
}

function dockerNetworkCommand(args: string[]): Promise<boolean> {
	return new Promise((resolve, reject) => {
		const child = spawn('docker', args);
		child.on('error', reject);
		child.on('close', (code) => resolve(code === 0));
	});
}

export async function ensureDockerNetwork(network: string): Promise<void> {
	if (BUILT_IN_NETWORKS.has(network)) return;
	if (await dockerNetworkCommand(['network', 'inspect', network])) return;
	if (await dockerNetworkCommand(['network', 'create', network])) return;
	throw new Error(`docker network create failed for ${network}`);
}
