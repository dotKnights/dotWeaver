import type {
	ProjectEnvVar,
	ProjectEnvironmentPrepareEvent,
	ProjectEnvironmentProfile,
	ProjectEnvironmentService,
	ProjectEnvironmentServiceEvent
} from '@prisma/client';

type EnvironmentEventModel =
	| Pick<ProjectEnvironmentPrepareEvent, 'id' | 'seq' | 'type' | 'payload' | 'createdAt'>
	| Pick<ProjectEnvironmentServiceEvent, 'id' | 'seq' | 'type' | 'payload' | 'createdAt'>;

type EnvironmentProfileFields = Pick<
	ProjectEnvironmentProfile,
	| 'id'
	| 'runtime'
	| 'packageManager'
	| 'status'
	| 'currentFingerprint'
	| 'lastPreparedFingerprint'
	| 'lastPrepareStatus'
	| 'lastPrepareError'
	| 'installCommand'
	| 'testCommand'
	| 'buildCommand'
	| 'devCommand'
	| 'warnings'
>;
type OptionalNullable<T> = { [Property in keyof T]?: T[Property] | null };
type EnvironmentServiceEnvMappingFields = OptionalNullable<Pick<ProjectEnvVar, 'key' | 'enabled'>>;
type EnvironmentServiceFields = OptionalNullable<
	Pick<ProjectEnvironmentService, 'id' | 'kind' | 'name' | 'enabled' | 'status' | 'lastError'>
>;

export type EnvironmentProfile = Record<string, unknown> & Partial<EnvironmentProfileFields>;

export type PrepareEvent = Partial<Omit<EnvironmentEventModel, 'createdAt'>> & {
	createdAt?: EnvironmentEventModel['createdAt'] | string | null;
};

export type EnvironmentServiceOutputSummary = {
	key?: string | null;
	value?: string | null;
	sensitive?: boolean | null;
	hasValue?: boolean | null;
};

type EnvironmentServiceEnvMappingSummary = EnvironmentServiceEnvMappingFields & {
	template?: string | null;
	sensitive?: 'auto' | ProjectEnvVar['sensitive'] | null;
};

export type EnvironmentServiceSourceFieldSummary = {
	key?: string | null;
	value?: string | null;
	sensitive?: boolean | null;
	hasValue?: boolean | null;
};

export type EnvironmentServiceSummary = EnvironmentServiceFields & {
	updatedAt?: ProjectEnvironmentService['updatedAt'] | string | null;
	outputs?: EnvironmentServiceOutputSummary[] | null;
	envMappings?: EnvironmentServiceEnvMappingSummary[] | null;
	sourceFields?: EnvironmentServiceSourceFieldSummary[] | null;
	mappingWarnings?: string[] | null;
	mappingErrors?: string[] | null;
};

export type EnvironmentServicesLoadState = {
	loading?: boolean;
	error?: string | null;
};

export type SetupStepStatus =
	| 'todo'
	| 'ready'
	| 'warning'
	| 'failed'
	| 'running'
	| 'optional'
	| 'stale';
type SetupPrimaryAction = 'detect' | 'prepare' | 'open_project';

export type EnvironmentSetupState = {
	runtime: { status: SetupStepStatus; label: string };
	envVars: { status: SetupStepStatus; label: string };
	services: { status: SetupStepStatus; label: string };
	prepare: { status: SetupStepStatus; label: string };
	canOpenProject: boolean;
	primaryAction: SetupPrimaryAction;
};

function warningLabel(value: unknown): string {
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

function serviceMessages(
	services: EnvironmentServiceSummary[],
	key: 'mappingWarnings' | 'mappingErrors'
): string[] {
	return services.flatMap((service) => {
		const value = service[key];
		return Array.isArray(value)
			? value.filter(
					(message): message is string => typeof message === 'string' && message.length > 0
				)
			: [];
	});
}

export function computeEnvironmentServicesSetupState(
	services: EnvironmentServiceSummary[],
	loadState: EnvironmentServicesLoadState = {}
): {
	status: SetupStepStatus;
	label: string;
	canOpenProject: boolean;
} {
	if (loadState.error) {
		return { status: 'failed', label: loadState.error, canOpenProject: false };
	}
	if (loadState.loading) {
		return { status: 'running', label: 'Loading services', canOpenProject: false };
	}

	const active = services.filter((service) => service.enabled !== false);
	if (services.length === 0) {
		return { status: 'ready', label: 'No services configured', canOpenProject: true };
	}
	if (active.some((service) => service.status === 'failed')) {
		return { status: 'failed', label: 'A service failed to provision', canOpenProject: false };
	}
	if (serviceMessages(active, 'mappingErrors').length > 0) {
		return {
			status: 'failed',
			label: 'Service environment mappings need fixes',
			canOpenProject: false
		};
	}
	if (active.some((service) => service.status === 'provisioning')) {
		return { status: 'running', label: 'Provisioning services', canOpenProject: false };
	}
	if (active.some((service) => service.status === 'configured' || !service.status)) {
		return { status: 'todo', label: 'Provision services before opening', canOpenProject: false };
	}
	if (active.every((service) => service.status === 'ready')) {
		if (serviceMessages(active, 'mappingWarnings').length > 0) {
			return {
				status: 'warning',
				label: 'Service environment mappings have warnings',
				canOpenProject: true
			};
		}
		if (services.some((service) => service.enabled === false)) {
			return { status: 'warning', label: 'Some services are disabled', canOpenProject: true };
		}
		return { status: 'ready', label: 'Services ready', canOpenProject: true };
	}
	return { status: 'warning', label: 'Some services need attention', canOpenProject: false };
}

export function computeEnvironmentSetupState(
	profile: EnvironmentProfile | null,
	services: EnvironmentServiceSummary[] = [],
	servicesLoadState: EnvironmentServicesLoadState = {}
): EnvironmentSetupState {
	const servicesState = computeEnvironmentServicesSetupState(services, servicesLoadState);
	if (!profile) {
		return {
			runtime: { status: 'todo', label: 'Detect environment' },
			envVars: { status: 'ready', label: 'No variables required yet' },
			services: servicesState,
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

	const prepareCanOpenProject = prepareStatus === 'ready' || prepareStatus === 'optional';
	const canOpenProject = prepareCanOpenProject && servicesState.canOpenProject;
	return {
		runtime: {
			status: runtimeStatus,
			label: profile.runtime
				? `${profile.runtime} / ${profile.packageManager ?? 'unknown'}`
				: 'Runtime configured'
		},
		envVars: { status: 'ready', label: 'Environment variables can be edited later' },
		services: servicesState,
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
