<script lang="ts">
	import { Bell, ExternalLink, GitBranch, KeyRound, Mail, Trash2 } from '@lucide/svelte';
	import { authClient } from '$lib/auth-client';
	import { Button } from '$lib/components/ui/button';
	import * as Alert from '$lib/components/ui/alert';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import ConnectorCard from '$lib/components/connectors/ConnectorCard.svelte';
	import { GMAIL_READONLY_SCOPE } from '$lib/constants/mail';
	import { listConnectors, disconnectGithub, disconnectGoogle } from '$lib/rfc/connectors.remote';
	import {
		deletePokeConnector,
		getPokeConnector,
		savePokeApiKey,
		setPokeEnabled
	} from '$lib/rfc/poke.remote';

	const connectors = listConnectors();
	const poke = getPokeConnector();
	let actionError = $state<string | null>(null);
	let pending = $state(false);
	let pokeApiKey = $state('');
	let pokePending = $state(false);
	let pokeError = $state<string | null>(null);

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

	async function savePoke() {
		const apiKey = pokeApiKey.trim();
		if (!apiKey) return;
		pokePending = true;
		pokeError = null;
		try {
			await savePokeApiKey({ apiKey });
			pokeApiKey = '';
			await poke.refresh();
		} catch (e) {
			pokeError = e instanceof Error ? e.message : 'Échec de la sauvegarde Poke.';
		} finally {
			pokePending = false;
		}
	}

	async function togglePoke(enabled: boolean) {
		pokePending = true;
		pokeError = null;
		try {
			await setPokeEnabled({ enabled });
			await poke.refresh();
		} catch (e) {
			pokeError = e instanceof Error ? e.message : 'Échec de la mise à jour Poke.';
		} finally {
			pokePending = false;
		}
	}

	async function removePoke() {
		pokePending = true;
		pokeError = null;
		try {
			await deletePokeConnector();
			pokeApiKey = '';
			await poke.refresh();
		} catch (e) {
			pokeError = e instanceof Error ? e.message : 'Échec de la suppression Poke.';
		} finally {
			pokePending = false;
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

	{#if poke.current}
		<ConnectorCard
			name="Poke"
			status={poke.current.connected ? 'connected' : 'disconnected'}
			description="Envoie les questions de l'agent sur votre téléphone."
		>
			{#snippet icon()}<Bell class="size-5" />{/snippet}
			{#snippet actions()}
				<div class="grid w-full gap-3">
					{#if pokeError}
						<Alert.Root variant="destructive">
							<Alert.Description>{pokeError}</Alert.Description>
						</Alert.Root>
					{/if}
					{#if poke.current.lastError}
						<Alert.Root variant="destructive">
							<Alert.Description
								>Dernière notification Poke: {poke.current.lastError}</Alert.Description
							>
						</Alert.Root>
					{/if}

					<div class="grid gap-2">
						<Label for="poke-api-key">Clé API Poke</Label>
						<div class="flex flex-col gap-2 sm:flex-row">
							<Input
								id="poke-api-key"
								type="password"
								bind:value={pokeApiKey}
								placeholder={poke.current.connected ? 'Remplacer la clé' : 'pk_...'}
								autocomplete="off"
							/>
							<Button onclick={savePoke} disabled={pokePending || !pokeApiKey.trim()}>
								<KeyRound class="size-4" />
								{poke.current.connected ? 'Remplacer' : 'Connecter'}
							</Button>
						</div>
					</div>

					{#if poke.current.connected}
						<label class="flex items-center gap-2 text-sm">
							<input
								type="checkbox"
								checked={poke.current.enabled}
								disabled={pokePending}
								onchange={(event) => togglePoke(event.currentTarget.checked)}
							/>
							Notifications Poke actives
						</label>
						<div class="flex flex-wrap items-center gap-2">
							<Button variant="outline" onclick={removePoke} disabled={pokePending}>
								<Trash2 class="size-4" />
								Supprimer
							</Button>
							{#if poke.current.lastNotifiedAt}
								<span class="text-xs text-muted-foreground">
									Dernier envoi: {new Date(poke.current.lastNotifiedAt).toLocaleString()}
								</span>
							{/if}
						</div>
					{/if}
				</div>
			{/snippet}
		</ConnectorCard>
	{/if}
</div>
