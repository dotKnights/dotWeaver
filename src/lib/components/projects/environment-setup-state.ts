export type EnvironmentProfile = Record<string, unknown> & {
	id?: string | null;
	runtime?: string | null;
	packageManager?: string | null;
	status?: string | null;
	currentFingerprint?: string | null;
	lastPreparedFingerprint?: string | null;
	lastPrepareStatus?: string | null;
	lastPrepareError?: string | null;
	installCommand?: string | null;
	testCommand?: string | null;
	buildCommand?: string | null;
	devCommand?: string | null;
	warnings?: unknown;
};

export type PrepareEvent = {
	id?: string | null;
	seq?: number | null;
	type?: string | null;
	payload?: unknown;
	createdAt?: string | Date | null;
};

export type SetupStepStatus =
	| 'todo'
	| 'ready'
	| 'warning'
	| 'failed'
	| 'running'
	| 'optional'
	| 'stale';
export type SetupPrimaryAction = 'detect' | 'prepare' | 'open_project';

export type EnvironmentSetupState = {
	runtime: { status: SetupStepStatus; label: string };
	envVars: { status: SetupStepStatus; label: string };
	services: { status: SetupStepStatus; label: string };
	prepare: { status: SetupStepStatus; label: string };
	canOpenProject: boolean;
	primaryAction: SetupPrimaryAction;
};

export function warningLabel(value: unknown): string {
	if (typeof value === 'string') return value;
	if (value === null || value === undefined) return '';
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

export function normalizeWarnings(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.map(warningLabel).filter(Boolean);
}

export function isPreparedEnvironment(profile: EnvironmentProfile | null): boolean {
	if (!profile) return false;
	return (
		profile.status === 'ready' &&
		!!profile.installCommand?.trim() &&
		profile.lastPrepareStatus === 'succeeded' &&
		profile.currentFingerprint === profile.lastPreparedFingerprint
	);
}

export function needsEnvironmentPrepare(profile: EnvironmentProfile | null): boolean {
	if (!profile?.installCommand?.trim()) return false;
	if (profile.lastPrepareStatus !== 'succeeded') return true;
	return profile.currentFingerprint !== profile.lastPreparedFingerprint;
}

export function computeEnvironmentSetupState(
	profile: EnvironmentProfile | null
): EnvironmentSetupState {
	if (!profile) {
		return {
			runtime: { status: 'todo', label: 'Detect environment' },
			envVars: { status: 'ready', label: 'No variables required yet' },
			services: { status: 'ready', label: 'No services configured' },
			prepare: { status: 'todo', label: 'Detect runtime before preparing' },
			canOpenProject: false,
			primaryAction: 'detect'
		};
	}

	const warnings = normalizeWarnings(profile.warnings);
	const runtimeStatus: SetupStepStatus =
		profile.status === 'invalid' ? 'failed' : warnings.length > 0 ? 'warning' : 'ready';

	let prepareStatus: SetupStepStatus;
	let prepareLabel: string;
	if (profile.status === 'invalid') {
		prepareStatus = 'failed';
		prepareLabel = 'Environment profile is invalid';
	} else if (!profile.installCommand?.trim()) {
		prepareStatus = 'optional';
		prepareLabel = 'No install command required';
	} else if (profile.lastPrepareStatus === 'running') {
		prepareStatus = 'running';
		prepareLabel = 'Preparing environment';
	} else if (profile.lastPrepareStatus === 'failed') {
		prepareStatus = 'failed';
		prepareLabel = profile.lastPrepareError || 'Prepare failed';
	} else if (isPreparedEnvironment(profile)) {
		prepareStatus = 'ready';
		prepareLabel = 'Environment prepared';
	} else if (profile.status !== 'ready') {
		prepareStatus = 'todo';
		prepareLabel = 'Prepare before running agents';
	} else if (profile.lastPrepareStatus === 'succeeded') {
		prepareStatus = 'stale';
		prepareLabel = 'Environment changed since last prepare';
	} else {
		prepareStatus = 'todo';
		prepareLabel = 'Prepare before running agents';
	}

	const canOpenProject = prepareStatus === 'ready' || prepareStatus === 'optional';
	return {
		runtime: {
			status: runtimeStatus,
			label: profile.runtime
				? `${profile.runtime} / ${profile.packageManager ?? 'unknown'}`
				: 'Runtime configured'
		},
		envVars: { status: 'ready', label: 'Environment variables can be edited later' },
		services: { status: 'ready', label: 'No services configured' },
		prepare: { status: prepareStatus, label: prepareLabel },
		canOpenProject,
		primaryAction: canOpenProject ? 'open_project' : 'prepare'
	};
}

export function eventCursor(event: PrepareEvent, index: number): number {
	return typeof event.seq === 'number' ? event.seq : index + 1;
}

export function isTerminalPrepareEvent(event: PrepareEvent): boolean {
	if (event.type === 'result') return true;
	if (event.type !== 'error') return false;
	const payload = event.payload;
	return (
		!!payload &&
		typeof payload === 'object' &&
		typeof (payload as Record<string, unknown>).message === 'string'
	);
}

export function eventLabel(event: PrepareEvent): string {
	const payload = event.payload;
	if (typeof payload === 'string') return payload;
	if (payload && typeof payload === 'object') {
		const record = payload as Record<string, unknown>;
		for (const key of ['text', 'message', 'error', 'reason', 'status']) {
			const value = record[key];
			if (typeof value === 'string' && value.length > 0) return value;
		}
	}
	return warningLabel(payload);
}

type MergePrepareEventEntry = {
	event: PrepareEvent;
	order: number;
	seq: number | null;
};

function prepareEventMergeKey(event: PrepareEvent, source: 'initial' | 'live', index: number) {
	if (typeof event.seq === 'number') return `seq:${event.seq}`;
	if (event.id) return `id:${event.id}`;
	return `${source}:${index}`;
}

export function mergePrepareEvents(initial: PrepareEvent[], live: PrepareEvent[]): PrepareEvent[] {
	const byKey = new Map<string, MergePrepareEventEntry>();
	let nextOrder = 0;

	function addEvent(event: PrepareEvent, source: 'initial' | 'live', index: number) {
		const key = prepareEventMergeKey(event, source, index);
		const existing = byKey.get(key);
		byKey.set(key, {
			event,
			order: existing?.order ?? nextOrder,
			seq: typeof event.seq === 'number' ? event.seq : null
		});
		nextOrder += 1;
	}

	initial.forEach((event, index) => addEvent(event, 'initial', index));
	live.forEach((event, index) => addEvent(event, 'live', index));

	return [...byKey.values()]
		.sort((a, b) => {
			if (a.seq !== null && b.seq !== null && a.seq !== b.seq) return a.seq - b.seq;
			return a.order - b.order;
		})
		.map((entry) => entry.event);
}
