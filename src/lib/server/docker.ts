import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface RunContainerSpec {
	image: string;
	name: string;
	/** Chemin hôte du checkout, bind-monté en RW sur /workspace. */
	workspacePath: string;
	/** Montages additionnels nécessaires au runtime agent. */
	mounts?: Array<{ source: string; target: string; readOnly?: boolean }>;
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
		'-i',
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
	for (const mount of spec.mounts ?? []) {
		args.push('-v', `${mount.source}:${mount.target}${mount.readOnly ? ':ro' : ''}`);
	}
	for (const [k, v] of Object.entries(spec.env)) {
		args.push('-e', `${k}=${v}`);
	}
	args.push(spec.image);
	return args;
}

export interface RunContainerResult {
	exitCode: number;
	timedOut: boolean;
}

export interface RunContainerOptions {
	/** Au-delà de ce délai, on `docker kill` le conteneur (nommé `name`) et on résout avec timedOut=true. */
	timeoutMs?: number;
	/** Nom du conteneur (pour le kill). Requis si timeoutMs est fourni. */
	name?: string;
}

export interface RunContainerControl {
	sendControlMessage(message: unknown): Promise<void>;
}

export type RunContainerLineHandler = (
	line: string,
	control: RunContainerControl
) => void | Promise<void>;

/** Lance le conteneur ; `onLine` reçoit chaque ligne stdout (JSON-lines de l'agent). */
export function runContainer(
	args: string[],
	onLine: RunContainerLineHandler,
	options: RunContainerOptions = {},
	onStderr?: (line: string) => void
): Promise<RunContainerResult> {
	const child = spawn('docker', args);
	const pending = new Set<Promise<void>>();
	let runError: unknown;
	let rejectRun: ((error: unknown) => void) | undefined;
	const rememberError = (error: unknown) => {
		runError ??= error;
	};
	const failRun = (error: unknown) => {
		rememberError(error);
		rejectRun?.(error);
	};
	const trackPending = (promise: Promise<void>) => {
		const tracked = promise.catch((error: unknown) => {
			rememberError(error);
		});
		pending.add(tracked);
		void tracked.finally(() => pending.delete(tracked));
		return promise;
	};
	const waitForPending = async () => {
		while (pending.size > 0) {
			await Promise.all([...pending]);
		}
	};
	const writeControlMessage = (message: unknown) =>
		new Promise<void>((resolve, reject) => {
			const payload = `${JSON.stringify(message)}\n`;
			try {
				child.stdin.write(payload, (error?: Error | null) => {
					if (error) {
						reject(error);
						return;
					}
					resolve();
				});
			} catch (error) {
				reject(error);
			}
		});
	const control: RunContainerControl = {
		sendControlMessage(message) {
			const write = writeControlMessage(message).catch((error: unknown) => {
				failRun(error);
				throw error;
			});
			trackPending(write);
			return write;
		}
	};
	const handleLine = (line: string) => {
		const pendingLine = Promise.resolve()
			.then(() => onLine(line, control))
			.catch((error: unknown) => {
				rememberError(error);
			});
		trackPending(pendingLine);
	};
	const out = createInterface({ input: child.stdout });
	out.on('line', handleLine);
	if (onStderr) {
		const err = createInterface({ input: child.stderr });
		err.on('line', onStderr);
	}
	let timedOut = false;
	let timer: NodeJS.Timeout | undefined;
	if (options.timeoutMs && options.name) {
		const name = options.name;
		timer = setTimeout(() => {
			timedOut = true;
			void killContainer(name);
		}, options.timeoutMs);
	}
	return new Promise((resolve, reject) => {
		rejectRun = (error: unknown) => {
			if (timer) clearTimeout(timer);
			reject(error);
		};
		child.on('error', (e) => {
			rejectRun?.(e);
		});
		child.stdin.on('error', failRun);
		child.on('close', (code) => {
			if (timer) clearTimeout(timer);
			void (async () => {
				if (timedOut) {
					resolve({ exitCode: code ?? -1, timedOut });
					return;
				}
				await waitForPending();
				if (runError) {
					reject(runError);
					return;
				}
				resolve({ exitCode: code ?? -1, timedOut });
			})().catch(reject);
		});
	});
}

/** Vrai si l'image existe localement (`docker image inspect` sort 0). */
export function imageExists(image: string): Promise<boolean> {
	return new Promise((resolve) => {
		const child = spawn('docker', ['image', 'inspect', image], { stdio: 'ignore' });
		child.on('close', (code) => resolve(code === 0));
		child.on('error', () => resolve(false));
	});
}

/**
 * Build l'image depuis `contextPath` (hérite stdio pour streamer la sortie docker).
 * `--network=host` : le builder legacy sur le bridge par défaut n'a pas toujours de DNS
 * fonctionnel (ex. hôte Coolify) → `apt-get` échoue. Le réseau hôte au build contourne
 * ça (portable ; sans effet notable sur Colima en local).
 */
export function buildImage(image: string, contextPath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn('docker', ['build', '--network=host', '-t', image, contextPath], {
			stdio: 'inherit'
		});
		child.on('error', reject);
		child.on('close', (code) =>
			code === 0 ? resolve() : reject(new Error(`docker build failed (exit ${code})`))
		);
	});
}

/**
 * Garantit que l'image agent est présente : si absente, la build depuis `contextPath`.
 * Évite le piège « le Dockerfile est à jour mais l'image utilisée ne l'est pas » sur une
 * machine neuve / après `colima delete`. (Un changement du Dockerfile sur une image déjà
 * présente n'est PAS détecté — utiliser `bun run runner:build-image` pour forcer.)
 */
export async function ensureImage(image: string, contextPath = 'docker/runner'): Promise<void> {
	if (await imageExists(image)) return;
	console.log(`[runner] image "${image}" absente → build depuis ${contextPath}…`);
	await buildImage(image, contextPath);
	console.log(`[runner] image "${image}" construite`);
}

/** Tue un conteneur par nom (annulation/timeout). Best-effort/idempotent. */
export function killContainer(name: string): Promise<void> {
	return new Promise((resolve) => {
		const child = spawn('docker', ['kill', name]);
		child.on('close', () => resolve());
		child.on('error', () => resolve());
	});
}
