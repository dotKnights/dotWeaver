<script lang="ts">
	import type { GithubTriggerEventType } from '@prisma/client';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Textarea } from '$lib/components/ui/textarea';
	import * as Select from '$lib/components/ui/select';
	import {
		EXAMPLE_TEMPLATE_VARS,
		GITHUB_TRIGGER_EVENTS,
		renderTemplate,
		TEMPLATE_VARIABLES_BY_EVENT,
		validatePromptTemplate
	} from '$lib/domain/github-triggers';
	import type { TriggerFormValues } from '$lib/components/triggers/trigger-form';
	import type { CreateGithubTriggerInput } from '$lib/schemas/github-triggers';
	import { CLAUDE_RUN_MODELS, CODEX_RUN_MODELS, RUN_AGENTS } from '$lib/schemas/runs';

	let {
		values = $bindable(),
		submitLabel,
		submitting = false,
		error = null,
		cancelHref,
		onsubmit
	}: {
		values: TriggerFormValues;
		submitLabel: string;
		submitting?: boolean;
		error?: string | null;
		cancelHref: string;
		onsubmit: (payload: Omit<CreateGithubTriggerInput, 'projectId'>) => void;
	} = $props();

	let showVariables = $state(false);

	const availableModels = $derived(
		values.agent === 'codex' ? CODEX_RUN_MODELS : CLAUDE_RUN_MODELS
	);
	const selectedAgentLabel = $derived(
		RUN_AGENTS.find((candidate) => candidate.value === values.agent)?.label ?? 'Agent'
	);
	const selectedModelLabel = $derived(
		availableModels.find((candidate) => candidate.value === values.model)?.label ?? 'Select a model'
	);
	const selectedEvent = $derived(
		GITHUB_TRIGGER_EVENTS.find((candidate) => candidate.value === values.eventType)
	);
	const availableVariables = $derived(TEMPLATE_VARIABLES_BY_EVENT[values.eventType]);
	const needsLabel = $derived(
		values.eventType === 'ISSUES_OPENED' || values.eventType === 'ISSUE_COMMENT_CREATED'
	);
	const unknownVariables = $derived(validatePromptTemplate(values.promptTemplate, values.eventType));
	const preview = $derived(renderTemplate(values.promptTemplate, EXAMPLE_TEMPLATE_VARS));
	const canSubmit = $derived(
		!submitting &&
			values.name.trim().length > 0 &&
			values.promptTemplate.trim().length > 0 &&
			values.model.length > 0 &&
			values.runBaseBranch.trim().length > 0 &&
			(!needsLabel || values.labelFilter.trim().length > 0) &&
			unknownVariables.length === 0
	);

	function handleEventTypeChange(value: string | undefined): void {
		if (!value) return;
		values.eventType = value as GithubTriggerEventType;
		// Les conditions ne sont pas partagées entre types d'évènement : on repart de zéro.
		values.labelFilter = '';
		values.commentKeyword = '';
		values.baseBranchPattern = '';
	}

	function handleAgentChange(value: string | undefined): void {
		values.agent = value === 'codex' ? 'codex' : 'claude';
		if (!availableModels.some((candidate) => candidate.value === values.model)) {
			values.model = availableModels[0].value;
		}
	}

	/** Reconstruit l'union discriminée attendue par le schéma à partir de l'état plat. */
	function buildConditions(): CreateGithubTriggerInput['conditions'] {
		if (values.eventType === 'ISSUES_OPENED') {
			return { eventType: 'ISSUES_OPENED', labelFilter: values.labelFilter.trim() };
		}
		if (values.eventType === 'ISSUE_COMMENT_CREATED') {
			return {
				eventType: 'ISSUE_COMMENT_CREATED',
				labelFilter: values.labelFilter.trim(),
				commentKeyword: values.commentKeyword.trim() || undefined
			};
		}
		return {
			eventType: 'PULL_REQUEST_REVIEW_SUBMITTED',
			baseBranchPattern: values.baseBranchPattern.trim() || undefined
		};
	}

	function handleSubmit(event: SubmitEvent): void {
		event.preventDefault();
		if (!canSubmit) return;
		onsubmit({
			name: values.name.trim(),
			description: values.description.trim() || undefined,
			enabled: values.enabled,
			conditions: buildConditions(),
			runTemplate: {
				agent: values.agent,
				model: values.model,
				runBaseBranch: values.runBaseBranch.trim(),
				promptTemplate: values.promptTemplate.trim()
			}
		});
	}
</script>

<form class="space-y-8" onsubmit={handleSubmit}>
	{#if error}
		<p class="border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>
	{/if}

	<section class="space-y-4 border border-neutral-200 bg-white p-5">
		<h2 class="text-sm font-semibold tracking-wide text-neutral-900 uppercase">Identity</h2>
		<div class="space-y-1.5">
			<Label for="trigger-name">Name</Label>
			<Input
				id="trigger-name"
				bind:value={values.name}
				placeholder="Auto-fix labelled bugs"
				maxlength={120}
				required
			/>
		</div>
		<div class="space-y-1.5">
			<Label for="trigger-description">Description</Label>
			<Textarea
				id="trigger-description"
				bind:value={values.description}
				rows={2}
				maxlength={500}
				placeholder="What this trigger is for (optional)"
			/>
		</div>
		<label class="flex items-center gap-2 text-sm text-neutral-700">
			<input
				type="checkbox"
				bind:checked={values.enabled}
				class="h-4 w-4 accent-[#2A34F5]"
			/>
			Enabled
		</label>
	</section>

	<section class="space-y-4 border border-neutral-200 bg-white p-5">
		<h2 class="text-sm font-semibold tracking-wide text-neutral-900 uppercase">
			Event &amp; conditions
		</h2>
		<div class="space-y-1.5">
			<Label for="trigger-event">Event type</Label>
			<Select.Root type="single" value={values.eventType} onValueChange={handleEventTypeChange}>
				<Select.Trigger id="trigger-event" class="w-full sm:w-80">
					{selectedEvent?.label ?? 'Select an event'}
				</Select.Trigger>
				<Select.Content>
					{#each GITHUB_TRIGGER_EVENTS as candidate (candidate.value)}
						<Select.Item value={candidate.value} label={candidate.label} />
					{/each}
				</Select.Content>
			</Select.Root>
			{#if selectedEvent}
				<p class="text-xs text-neutral-500">{selectedEvent.description}</p>
			{/if}
		</div>

		{#if needsLabel}
			<div class="space-y-1.5">
				<Label for="trigger-label">Label filter</Label>
				<Input
					id="trigger-label"
					bind:value={values.labelFilter}
					placeholder="ai-fix"
					class="sm:w-80"
					required
				/>
				<p class="text-xs text-neutral-500">
					The issue must carry this exact label (case-insensitive).
				</p>
			</div>
		{/if}

		{#if values.eventType === 'ISSUE_COMMENT_CREATED'}
			<div class="space-y-1.5">
				<Label for="trigger-keyword">Comment keyword</Label>
				<Input
					id="trigger-keyword"
					bind:value={values.commentKeyword}
					placeholder="/ai-fix"
					class="sm:w-80"
				/>
				<p class="text-xs text-neutral-500">
					Optional. The comment body must contain this text (case-insensitive).
				</p>
			</div>
		{/if}

		{#if values.eventType === 'PULL_REQUEST_REVIEW_SUBMITTED'}
			<div class="space-y-1.5">
				<Label for="trigger-base-pattern">Base branch pattern</Label>
				<Input
					id="trigger-base-pattern"
					bind:value={values.baseBranchPattern}
					placeholder="main or release/*"
					class="sm:w-80"
				/>
				<p class="text-xs text-neutral-500">
					Optional glob. Leave empty to match any base branch. Only reviews requesting changes
					fire this trigger.
				</p>
			</div>
		{/if}
	</section>

	<section class="space-y-4 border border-neutral-200 bg-white p-5">
		<h2 class="text-sm font-semibold tracking-wide text-neutral-900 uppercase">Run template</h2>
		<div class="flex flex-col gap-4 sm:flex-row">
			<div class="space-y-1.5">
				<Label for="trigger-agent">Agent</Label>
				<Select.Root type="single" value={values.agent} onValueChange={handleAgentChange}>
					<Select.Trigger id="trigger-agent" class="w-full sm:w-44">
						{selectedAgentLabel}
					</Select.Trigger>
					<Select.Content>
						{#each RUN_AGENTS as candidate (candidate.value)}
							<Select.Item value={candidate.value} label={candidate.label} />
						{/each}
					</Select.Content>
				</Select.Root>
			</div>
			<div class="space-y-1.5">
				<Label for="trigger-model">Model</Label>
				<Select.Root
					type="single"
					value={values.model}
					onValueChange={(v) => (values.model = v ?? '')}
				>
					<Select.Trigger id="trigger-model" class="w-full sm:w-52">
						{selectedModelLabel}
					</Select.Trigger>
					<Select.Content>
						{#each availableModels as candidate (candidate.value)}
							<Select.Item value={candidate.value} label={candidate.label} />
						{/each}
					</Select.Content>
				</Select.Root>
			</div>
			<div class="flex-1 space-y-1.5">
				<Label for="trigger-base-branch">Base branch</Label>
				<Input id="trigger-base-branch" bind:value={values.runBaseBranch} required />
				<p class="text-xs text-neutral-500">
					Use <code class="bg-neutral-100 px-1">{'{{default_branch}}'}</code> to always use the
					repo's default branch.
				</p>
			</div>
		</div>

		<div class="space-y-1.5">
			<Label for="trigger-prompt">Prompt template</Label>
			<Textarea
				id="trigger-prompt"
				bind:value={values.promptTemplate}
				rows={8}
				class="font-mono"
				placeholder={'Fix the following issue.\n\n<issue_title>{{issue.title}}</issue_title>'}
				required
			/>
			{#if unknownVariables.length > 0}
				<p class="text-xs text-red-600">
					Unknown variable{unknownVariables.length > 1 ? 's' : ''} for this event:
					{unknownVariables.map((name) => `{{${name}}}`).join(', ')}
				</p>
			{/if}
			<p class="text-xs text-neutral-500">
				Issue and comment text is untrusted input. Wrap it in tags such as
				<code class="bg-neutral-100 px-1">&lt;issue_title&gt;…&lt;/issue_title&gt;</code> so it
				cannot escape its section. Long values are truncated to 8,000 characters.
			</p>

			<button
				type="button"
				class="text-xs font-medium text-[#2A34F5] hover:underline"
				onclick={() => (showVariables = !showVariables)}
			>
				{showVariables ? 'Hide' : 'Show'} available variables
			</button>
			{#if showVariables}
				<dl class="grid gap-x-4 gap-y-1 border border-neutral-200 bg-neutral-50 p-3 sm:grid-cols-2">
					{#each availableVariables as variable (variable.name)}
						<div class="flex gap-2 text-xs">
							<dt class="font-mono text-[#2A34F5]">{`{{${variable.name}}}`}</dt>
							<dd class="text-neutral-500">{variable.description}</dd>
						</div>
					{/each}
				</dl>
			{/if}
		</div>

		<div class="space-y-1.5">
			<span class="text-sm font-medium text-neutral-900">Preview</span>
			<pre
				class="max-h-64 overflow-auto border border-neutral-200 bg-neutral-50 p-3 font-mono text-xs whitespace-pre-wrap text-neutral-700">{preview ||
					'Nothing to preview yet.'}</pre>
			<p class="text-xs text-neutral-500">Rendered with example values.</p>
		</div>
	</section>

	<div class="flex items-center gap-3">
		<Button type="submit" disabled={!canSubmit} class="bg-[#2A34F5] text-white hover:bg-[#2A34F5]/90">
			{submitting ? 'Saving…' : submitLabel}
		</Button>
		<a href={cancelHref} class="text-sm text-neutral-500 hover:underline">Cancel</a>
	</div>
</form>
