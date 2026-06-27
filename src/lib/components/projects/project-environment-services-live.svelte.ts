import { SvelteMap } from 'svelte/reactivity';
import type { EnvironmentServiceSummary, PrepareEvent } from './environment-setup-state';

type ProjectEnvironmentServicesLiveStateInput = {
	projectId: () => string;
	profileId: () => string;
	services: () => EnvironmentServiceSummary[];
};

type LiveServiceEvent = {
	projectId: string;
	serviceId: string;
	event: PrepareEvent;
};

type LiveServicePatch = Partial<EnvironmentServiceSummary> & { id?: string | null };

function serviceKey(projectId: string, serviceId: string) {
	return `${projectId}:${serviceId}`;
}

function parseJsonEvent(event: MessageEvent<string>): unknown {
	try {
		return JSON.parse(event.data);
	} catch {
		return null;
	}
}

function timestamp(value: string | Date | null | undefined): number | null {
	if (!value) return null;
	const time = value instanceof Date ? value.getTime() : Date.parse(value);
	return Number.isFinite(time) ? time : null;
}

export function mergeEnvironmentServiceLivePatch(
	service: EnvironmentServiceSummary,
	patch: LiveServicePatch | undefined
): EnvironmentServiceSummary {
	if (!patch) return service;
	const serviceTime = timestamp(service.updatedAt);
	const patchTime = timestamp(patch.updatedAt);
	if (serviceTime !== null && patchTime !== null && patchTime < serviceTime) return service;
	return { ...service, ...patch };
}

export function createProjectEnvironmentServicesLiveState(
	input: ProjectEnvironmentServicesLiveStateInput
) {
	const liveServices = new SvelteMap<string, LiveServicePatch>();
	const liveEvents = new SvelteMap<string, LiveServiceEvent>();
	const currentProjectId = $derived(input.projectId());
	const currentProfileId = $derived(input.profileId());
	const currentServices = $derived(input.services());

	$effect(() => {
		const projectId = currentProjectId;
		const profileId = currentProfileId;
		const services = currentServices.filter((service) => !!service.id);
		if (!projectId || !profileId || services.length === 0) return;

		const sources = services.map((service) => {
			const serviceId = service.id!;
			const key = serviceKey(projectId, serviceId);
			const source = new EventSource(
				`/api/projects/${encodeURIComponent(projectId)}/environment-services/${encodeURIComponent(
					serviceId
				)}/events`
			);

			const handleService = (event: MessageEvent<string>) => {
				const payload = parseJsonEvent(event);
				if (!payload || typeof payload !== 'object') return;
				liveServices.set(key, payload as LiveServicePatch);
			};

			const handleServiceEvent = (event: MessageEvent<string>) => {
				const payload = parseJsonEvent(event);
				if (!payload || typeof payload !== 'object') return;
				const serviceEvent = payload as PrepareEvent;
				let eventKey = `${key}:fallback:${event.data}`;
				if (typeof serviceEvent.seq === 'number') {
					eventKey = `${key}:seq:${serviceEvent.seq}`;
				} else if (serviceEvent.id) {
					eventKey = `${key}:id:${serviceEvent.id}`;
				} else if (event.lastEventId) {
					eventKey = `${key}:last-event-id:${event.lastEventId}`;
				}
				if (liveEvents.has(eventKey)) return;
				liveEvents.set(eventKey, { projectId, serviceId, event: serviceEvent });
			};

			source.addEventListener('service', handleService);
			source.addEventListener('service_event', handleServiceEvent);
			return source;
		});

		return () => {
			for (const source of sources) source.close();
		};
	});

	return {
		get services(): EnvironmentServiceSummary[] {
			const projectId = currentProjectId;
			return currentServices.map((service) => {
				if (!projectId || !service.id) return service;
				return mergeEnvironmentServiceLivePatch(
					service,
					liveServices.get(serviceKey(projectId, service.id))
				);
			});
		},
		events(serviceId: string): PrepareEvent[] {
			const projectId = currentProjectId;
			return [...liveEvents.values()]
				.filter((live) => live.projectId === projectId && live.serviceId === serviceId)
				.map((live) => live.event);
		}
	};
}
