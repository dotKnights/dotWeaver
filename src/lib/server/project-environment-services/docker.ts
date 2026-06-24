import { spawn } from 'node:child_process';

function sanitizeDockerPart(value: string): string {
	return value
		.replace(/[^a-zA-Z0-9_.-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 48);
}

export function buildServiceContainerName(projectId: string, serviceName: string): string {
	return `dotweaver-p-${sanitizeDockerPart(projectId)}-svc-${sanitizeDockerPart(serviceName)}`;
}

export function buildServiceVolumeName(projectId: string, serviceName: string): string {
	return `dotweaver-p-${sanitizeDockerPart(projectId)}-vol-${sanitizeDockerPart(serviceName)}`;
}

export function buildServiceNetworkAlias(projectId: string, serviceName: string): string {
	return buildServiceContainerName(projectId, serviceName);
}

export function buildServiceRunArgs(input: {
	image: string;
	containerName: string;
	network: string;
	networkAlias: string;
	volumeName: string;
	volumeTarget: string;
	env: Record<string, string>;
	command: string[];
}): string[] {
	const args = [
		'run',
		'-d',
		'--restart',
		'unless-stopped',
		'--name',
		input.containerName,
		'--network',
		input.network,
		'--network-alias',
		input.networkAlias,
		'-v',
		`${input.volumeName}:${input.volumeTarget}`
	];
	for (const [key, value] of Object.entries(input.env)) {
		args.push('-e', `${key}=${value}`);
	}
	args.push(input.image);
	args.push(...input.command);
	return args;
}

export function runDockerCommand(args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn('docker', args, { stdio: 'ignore' });
		child.on('error', reject);
		child.on('close', (code) => {
			if (code === 0) {
				resolve();
				return;
			}
			const command = args[0] ?? 'command';
			reject(new Error(`docker ${command} failed with exit code ${code}`));
		});
	});
}
