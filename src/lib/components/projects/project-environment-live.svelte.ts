import { SvelteMap } from 'svelte/reactivity';
import {
	mergePrepareEvents,
	type EnvironmentProfile,
	type PrepareEvent
} from './environment-setup-state';

type ProjectEnvironmentLiveStateInput = {
	projectId: () => string;
	profileId: () => string;
	environment: () => EnvironmentProfile | null | undefined;
	prepareEvents: () => PrepareEvent[];
};

type LivePrepareEvent = {
	projectId: string;
	profileId: string;
	event: PrepareEvent;
};

function environmentKey(projectId: string, profileId: string) {
	return `${projectId}:${profileId}`;
}

export function createProjectEnvironmentLiveState(input: ProjectEnvironmentLiveStateInput) {
	const liveEnvironmentProfiles = new SvelteMap<string, EnvironmentProfile>();
	const livePrepareEvents = new SvelteMap<string, LivePrepareEvent>();
	const currentProjectId = $derived(input.projectId());
	const currentProfileId = $derived(input.profileId());
	const currentEnvironmentKey = $derived(environmentKey(currentProjectId, currentProfileId));
	const currentEventsUrl = $derived(
		currentProjectId && currentProfileId
			? `/api/projects/${encodeURIComponent(currentProjectId)}/environment/${encodeURIComponent(
					currentProfileId
				)}/events`
			: ''
	);

	$effect(() => {
		const projectId = currentProjectId;
		const profileId = currentProfileId;
		const key = currentEnvironmentKey;
		const url = currentEventsUrl;
		if (!projectId || !profileId || !url) return;

		const source = new EventSource(url);

		const handleProfile = (event: MessageEvent<string>) => {
			let payload: unknown;
			try {
				payload = JSON.parse(event.data);
			} catch {
				return;
			}
			if (!payload || typeof payload !== 'object') return;
			liveEnvironmentProfiles.set(key, {
				...(liveEnvironmentProfiles.get(key) ?? {}),
				...(payload as EnvironmentProfile)
			});
		};

		const handlePrepareEvent = (event: MessageEvent<string>) => {
			let payload: unknown;
			try {
				payload = JSON.parse(event.data);
			} catch {
				return;
			}
			if (!payload || typeof payload !== 'object') return;
			const prepareEvent = payload as PrepareEvent;
			let eventKey = `${key}:fallback:${event.data}`;
			if (typeof prepareEvent.seq === 'number') {
				eventKey = `${key}:seq:${prepareEvent.seq}`;
			} else if (prepareEvent.id) {
				eventKey = `${key}:id:${prepareEvent.id}`;
			} else if (event.lastEventId) {
				eventKey = `${key}:last-event-id:${event.lastEventId}`;
			}
			if (livePrepareEvents.has(eventKey)) return;
			livePrepareEvents.set(eventKey, { projectId, profileId, event: prepareEvent });
		};

		source.addEventListener('profile', handleProfile);
		source.addEventListener('prepare_event', handlePrepareEvent);

		return () => {
			source.close();
		};
	});

	return {
		get environment(): EnvironmentProfile | null {
			const current = input.environment() ?? null;
			const projectId = currentProjectId;
			const profileId = current?.id ?? input.profileId();
			if (!projectId || !profileId) return current;
			const liveProfile = liveEnvironmentProfiles.get(environmentKey(projectId, profileId));
			return liveProfile ? { ...current, ...liveProfile } : current;
		},
		get prepareEvents(): PrepareEvent[] {
			const projectId = currentProjectId;
			const profileId = currentProfileId;
			const liveEvents = [...livePrepareEvents.values()]
				.filter((live) => live.projectId === projectId && live.profileId === profileId)
				.map((live) => live.event);
			return mergePrepareEvents(input.prepareEvents(), liveEvents);
		}
	};
}
