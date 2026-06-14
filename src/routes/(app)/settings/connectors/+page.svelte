<script lang="ts">
	import { GitBranch, Mail, ExternalLink } from '@lucide/svelte';
	import { authClient } from '$lib/auth-client';
	import { Button } from '$lib/components/ui/button';
	import * as Alert from '$lib/components/ui/alert';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import ConnectorCard from '$lib/components/connectors/ConnectorCard.svelte';
	import { GMAIL_READONLY_SCOPE } from '$lib/constants/mail';
	import { listConnectors, disconnectGithub, disconnectGoogle } from '$lib/rfc/connectors.remote';

	const connectors = listConnectors();
	let actionError = $state<string | null>(null);
	let pending = $state(false);

	const CALLBACK = '/settings/connectors';

	async function connectGithub() {
		actionError = null;
		await authClient.linkSocial({ provider: 'github', scopes: ['repo'], callbackURL: CALLBACK });
	}

	async function connectGoogle() {
		actionError = null;
		await authClient.linkSocial({
			provider: 'google',
			scopes: [GMAIL_READONLY_SCOPE],
			callbackURL: CALLBACK
		});
	}

	async function runDisconnect(fn: () => Promise<{ ok: true }>) {
		actionError = null;
		pending = true;
		try {
			await fn();
			await connectors.refresh();
		} catch (e) {
			actionError = e instanceof Error ? e.message : 'Échec de la déconnexion.';
		} finally {
			pending = false;
		}
	}
</script>

<svelte:head>
	<title>Connecteurs | dotWeaver</title>
</svelte:head>

<div class="mx-auto max-w-2xl space-y-6 p-6">
	<div>
		<h1 class="text-2xl font-semibold">Connecteurs</h1>
		<p class="text-sm text-muted-foreground">Gérez vos comptes connectés.</p>
	</div>

	{#if actionError}
		<Alert.Root variant="destructive">
			<Alert.Description>{actionError}</Alert.Description>
		</Alert.Root>
	{/if}

	{#if connectors.current}
		{@const c = connectors.current}

		<ConnectorCard
			name="GitHub"
			status={c.github.connected ? 'connected' : 'disconnected'}
			description="Accès à vos dépôts pour importer des projets."
		>
			{#snippet icon()}<GitBranch class="size-5" />{/snippet}
			{#snippet actions()}
				{#if c.github.connected}
					<Button variant="outline" href={c.githubOrgAccessUrl} target="_blank" rel="noopener">
						Gérer l'accès org <ExternalLink class="ml-1 size-4" />
					</Button>
					<AlertDialog.Root>
						<AlertDialog.Trigger
							disabled={!c.github.canDisconnect || pending}
							class="text-sm text-destructive underline-offset-4 hover:underline disabled:opacity-50"
						>
							Déconnecter
						</AlertDialog.Trigger>
						<AlertDialog.Content>
							<AlertDialog.Header>
								<AlertDialog.Title>Déconnecter GitHub ?</AlertDialog.Title>
								<AlertDialog.Description>
									L'application n'aura plus accès à vos dépôts GitHub.
								</AlertDialog.Description>
							</AlertDialog.Header>
							<AlertDialog.Footer>
								<AlertDialog.Cancel>Annuler</AlertDialog.Cancel>
								<AlertDialog.Action onclick={() => runDisconnect(disconnectGithub)}>
									Déconnecter
								</AlertDialog.Action>
							</AlertDialog.Footer>
						</AlertDialog.Content>
					</AlertDialog.Root>
					{#if !c.github.canDisconnect}
						<span class="text-xs text-muted-foreground">Seule méthode de connexion.</span>
					{/if}
				{:else}
					<Button onclick={connectGithub}>Connecter GitHub</Button>
				{/if}
			{/snippet}
		</ConnectorCard>

		<ConnectorCard
			name="Google (Gmail)"
			status={c.google.needsReconnect
				? 'needs_reconnect'
				: c.google.connected
					? 'connected'
					: 'disconnected'}
			description="Lecture de vos emails dans dotWeaver."
		>
			{#snippet icon()}<Mail class="size-5" />{/snippet}
			{#snippet actions()}
				{#if c.google.connected}
					{#if c.google.needsReconnect}
						<Button onclick={connectGoogle}>Reconnecter Google</Button>
					{/if}
					<AlertDialog.Root>
						<AlertDialog.Trigger
							disabled={!c.google.canDisconnect || pending}
							class="text-sm text-destructive underline-offset-4 hover:underline disabled:opacity-50"
						>
							Déconnecter
						</AlertDialog.Trigger>
						<AlertDialog.Content>
							<AlertDialog.Header>
								<AlertDialog.Title>Déconnecter Google ?</AlertDialog.Title>
								<AlertDialog.Description>
									Vos emails synchronisés seront supprimés de dotWeaver.
								</AlertDialog.Description>
							</AlertDialog.Header>
							<AlertDialog.Footer>
								<AlertDialog.Cancel>Annuler</AlertDialog.Cancel>
								<AlertDialog.Action onclick={() => runDisconnect(disconnectGoogle)}>
									Déconnecter et supprimer
								</AlertDialog.Action>
							</AlertDialog.Footer>
						</AlertDialog.Content>
					</AlertDialog.Root>
					{#if !c.google.canDisconnect}
						<span class="text-xs text-muted-foreground">Seule méthode de connexion.</span>
					{/if}
				{:else}
					<Button onclick={connectGoogle}>Connecter Google</Button>
				{/if}
			{/snippet}
		</ConnectorCard>
	{/if}
</div>
