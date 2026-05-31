import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface RunContainerSpec {
	image: string;
	name: string;
	/** Chemin hôte du checkout, bind-monté en RW sur /workspace. */
	workspacePath: string;
	/** Variables injectées (RUN_PROMPT, CLAUDE_CODE_OAUTH_TOKEN, …). */
	env: Record<string, string>;
	memory?: string; // défaut '4g'
	cpus?: string; // défaut '2'
	pidsLimit?: number; // défaut 512
	network?: string; // défaut 'bridge' (MVP) ; 'none'+proxy en durcissement
}

/**
 * Construit l'argv de `docker run`. Durcissement MVP : cap-drop ALL,
 * no-new-privileges, limites CPU/RAM/PID. (rootfs read-only + egress allowlist = Phase 5.)
 */
export function buildRunArgs(spec: RunContainerSpec): string[] {
	const args = [
		'run',
		'--rm',
		'--name',
		spec.name,
		'--cap-drop',
		'ALL',
		'--security-opt',
		'no-new-privileges',
		'--pids-limit',
		String(spec.pidsLimit ?? 512),
		'--memory',
		spec.memory ?? '4g',
		'--cpus',
		spec.cpus ?? '2',
		'--network',
		spec.network ?? 'bridge',
		'-v',
		`${spec.workspacePath}:/workspace`,
		'-w',
		'/workspace'
	];
	for (const [k, v] of Object.entries(spec.env)) {
		args.push('-e', `${k}=${v}`);
	}
	args.push(spec.image);
	return args;
}

export interface RunContainerResult {
	exitCode: number;
}

/** Lance le conteneur ; `onLine` reçoit chaque ligne stdout (JSON-lines de l'agent). */
export function runContainer(
	args: string[],
	onLine: (line: string) => void,
	onStderr?: (line: string) => void
): Promise<RunContainerResult> {
	const child = spawn('docker', args);
	const out = createInterface({ input: child.stdout });
	out.on('line', onLine);
	if (onStderr) {
		const err = createInterface({ input: child.stderr });
		err.on('line', onStderr);
	}
	return new Promise((resolve, reject) => {
		child.on('error', reject);
		child.on('close', (code) => resolve({ exitCode: code ?? -1 }));
	});
}

/** Tue un conteneur par nom (annulation/timeout). Best-effort/idempotent. */
export function killContainer(name: string): Promise<void> {
	return new Promise((resolve) => {
		const child = spawn('docker', ['kill', name]);
		child.on('close', () => resolve());
		child.on('error', () => resolve());
	});
}
