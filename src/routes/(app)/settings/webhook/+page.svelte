<script lang="ts">
	import { page } from '$app/state';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import {
		getWebhookSecretStatus,
		rotateOrganizationWebhookSecret
	} from '$lib/rfc/github-triggers.remote';
	import { listMyTeams } from '$lib/rfc/teams.remote';

	const myTeams = listMyTeams();
	const organizationId = $derived(myTeams.current?.activeOrganizationId ?? null);
	const status = $derived(organizationId ? getWebhookSecretStatus({ organizationId }) : null);
	const configured = $derived(status?.current?.configured ?? false);
	const webhookUrl = $derived(
		organizationId ? `${page.url.origin}/api/github/webhook?orgId=${organizationId}` : ''
	);

	let generating = $state(false);
	let error = $state<string | null>(null);
	/** Secret affiché une seule fois, juste après génération. */
	let revealedSecret = $state<string | null>(null);
	let confirmingRotation = $state(false);
	let showInstructions = $state(false);
	let copied = $state<'url' | 'secret' | null>(null);

	async function generateSecret(): Promise<void> {
		if (!organizationId) return;
		error = null;
		generating = true;
		try {
			const result = await rotateOrganizationWebhookSecret({ organizationId });
			revealedSecret = result.secret;
			confirmingRotation = false;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to generate the webhook secret';
		} finally {
			generating = false;
		}
	}

	async function copy(value: string, what: 'url' | 'secret'): Promise<void> {
		try {
			await navigator.clipboard.writeText(value);
			copied = what;
		} catch {
			error = 'Could not copy to the clipboard';
		}
	}
</script>

<div class="mx-auto max-w-3xl space-y-6 bg-white p-6">
	<div class="space-y-1">
		<h1 class="text-2xl font-semibold text-neutral-900">Webhook Secret</h1>
		<p class="text-sm text-neutral-500">
			Configure the signing secret for your organization's GitHub webhook.
		</p>
	</div>

	{#if error}
		<p class="border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>
	{/if}

	{#if status?.error}
		<p class="text-sm text-red-600">{status.error.message}</p>
	{:else if !organizationId}
		<p class="text-sm text-neutral-500">Loading organization…</p>
	{:else}
		<section class="space-y-2 border border-neutral-200 bg-white p-5">
			<h2 class="text-sm font-semibold tracking-wide text-neutral-900 uppercase">Webhook URL</h2>
			<div class="flex items-center gap-2">
				<code class="min-w-0 flex-1 truncate border border-neutral-200 bg-neutral-50 px-2 py-1.5 text-xs">
					{webhookUrl}
				</code>
				<Button variant="outline" onclick={() => copy(webhookUrl, 'url')}>
					{copied === 'url' ? 'Copied' : 'Copy'}
				</Button>
			</div>
		</section>

		<section class="space-y-3 border border-neutral-200 bg-white p-5">
			<div class="flex items-center justify-between">
				<h2 class="text-sm font-semibold tracking-wide text-neutral-900 uppercase">
					Webhook secret
				</h2>
				{#if configured}
					<Badge class="bg-[#2A34F5] text-white">Configured</Badge>
				{:else}
					<Badge variant="outline">Not configured</Badge>
				{/if}
			</div>

			{#if revealedSecret}
				<div class="space-y-2 border border-[#2A34F5]/30 bg-[#2A34F5]/5 p-3">
					<p class="text-xs font-medium text-[#2A34F5]">
						Copy this secret now — it will never be shown again.
					</p>
					<div class="flex items-center gap-2">
						<code class="min-w-0 flex-1 truncate border border-neutral-200 bg-white px-2 py-1.5 text-xs">
							{revealedSecret}
						</code>
						<Button variant="outline" onclick={() => copy(revealedSecret ?? '', 'secret')}>
							{copied === 'secret' ? 'Copied' : 'Copy'}
						</Button>
					</div>
				</div>
			{:else if configured}
				<div class="flex items-center gap-2">
					<code class="border border-neutral-200 bg-neutral-50 px-2 py-1.5 text-xs">
						••••••••••••••••
					</code>
					<span class="text-xs text-neutral-500">
						Stored encrypted. Rotate if you lost it.
					</span>
				</div>
			{/if}

			<div>
				{#if configured}
					<Button
						variant="outline"
						disabled={generating}
						onclick={() => (confirmingRotation = true)}
					>
						Rotate secret
					</Button>
				{:else}
					<Button
						class="bg-[#2A34F5] text-white hover:bg-[#2A34F5]/90"
						disabled={generating}
						onclick={generateSecret}
					>
						{generating ? 'Generating…' : 'Generate secret'}
					</Button>
				{/if}
			</div>

			<p class="text-xs text-neutral-500">
				Paste this secret into GitHub → Repository Settings → Webhooks → Secret.
			</p>
		</section>

		<section class="border border-neutral-200 bg-white p-5">
			<button
				type="button"
				class="text-sm font-medium text-[#2A34F5] hover:underline"
				onclick={() => (showInstructions = !showInstructions)}
			>
				{showInstructions ? 'Hide' : 'Show'} setup instructions
			</button>
			{#if showInstructions}
				<ol class="mt-3 list-decimal space-y-1 pl-5 text-sm text-neutral-700">
					<li>Copy the Webhook URL above.</li>
					<li>In GitHub, go to your repository → Settings → Webhooks → Add webhook.</li>
					<li>Paste the URL into “Payload URL”.</li>
					<li>Set Content type to <code class="bg-neutral-100 px-1">application/json</code>.</li>
					<li>Generate a secret here and paste it into GitHub's “Secret” field.</li>
					<li>Select events: Issues, Issue comments, Pull request reviews.</li>
					<li>Click “Add webhook”.</li>
				</ol>
			{/if}
		</section>
	{/if}
</div>

<AlertDialog.Root
	open={confirmingRotation}
	onOpenChange={(open) => (confirmingRotation = open)}
>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Rotate the webhook secret?</AlertDialog.Title>
			<AlertDialog.Description>
				The current secret stops working immediately. GitHub deliveries will fail until you paste
				the new secret into the webhook settings.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action
				class="bg-[#2A34F5] text-white hover:bg-[#2A34F5]/90"
				disabled={generating}
				onclick={generateSecret}
			>
				Rotate
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
