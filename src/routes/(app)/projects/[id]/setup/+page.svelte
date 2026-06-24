<script lang="ts">
	import { page } from '$app/state';
	import ProjectSetupChecklist from '$lib/components/projects/ProjectSetupChecklist.svelte';
	import { createProjectEnvironmentLiveState } from '$lib/components/projects/project-environment-live.svelte';
	import {
		detectProjectEnvironment,
		getProjectEnvironment,
		getProjectEnvironmentPrepareEvents,
		prepareProjectEnvironment,
		saveProjectEnvironment
	} from '$lib/rfc/project-environments.remote';
	import { getProject } from '$lib/rfc/projects.remote';

	const projectId = $derived(page.params.id!);
	const project = $derived(getProject(projectId));
	const environment = $derived(getProjectEnvironment(projectId));
	const environmentProfileId = $derived(environment.current?.id ?? '');
	const environmentPrepareEvents = $derived(
		environmentProfileId
			? getProjectEnvironmentPrepareEvents({
					projectId,
					profileId: environmentProfileId
				})
			: null
	);
	const liveEnvironment = createProjectEnvironmentLiveState({
		projectId: () => projectId,
		profileId: () => environmentProfileId,
		environment: () => environment.current,
		prepareEvents: () => environmentPrepareEvents?.current ?? []
	});
</script>

<svelte:head>
	<title>Project setup | dotWeaver</title>
</svelte:head>

<div class="mx-auto max-w-5xl space-y-6 p-6">
	{#if project.error}
		<p class="text-sm text-red-500">{project.error.message}</p>
	{:else if environment.error}
		<p class="text-sm text-red-500">{environment.error.message}</p>
	{:else if project.current && environment.current !== undefined}
		{#key `${projectId}:${environment.current?.id ?? 'none'}`}
			<ProjectSetupChecklist
				{projectId}
				project={project.current}
				environment={liveEnvironment.environment}
				prepareEvents={liveEnvironment.prepareEvents}
				onDetect={detectProjectEnvironment}
				onSave={saveProjectEnvironment}
				onPrepare={prepareProjectEnvironment}
			/>
		{/key}
	{:else}
		<p class="text-sm text-muted-foreground">Loading project setup...</p>
	{/if}
</div>
