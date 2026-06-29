<script lang="ts">
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client as zodClient } from 'sveltekit-superforms/adapters';
	import { registerSchema } from '$lib/schemas/auth';
	import { authClient } from '$lib/auth-client';
	import { goto } from '$app/navigation';
	import { Button } from '$lib/components/ui/button';
	import { Separator } from '$lib/components/ui/separator';
	import AuthCard from '$lib/components/auth/AuthCard.svelte';
	import AuthField from '$lib/components/auth/AuthField.svelte';

	let { data } = $props();
	let authError = $state<string | null>(null);
	let loading = $state(false);

	// svelte-ignore state_referenced_locally
	const { form, errors, enhance } = superForm(data.form, {
		validators: zodClient(registerSchema),
		async onSubmit({ formData, cancel }) {
			cancel();
			authError = null;
			loading = true;

			try {
				const { error } = await authClient.signUp.email({
					name: formData.get('name') as string,
					email: formData.get('email') as string,
					password: formData.get('password') as string,
					callbackURL: '/dashboard'
				});

				if (error) {
					authError = error.message ?? 'Could not create account. Please try again.';
					loading = false;
					return;
				}

				loading = false;
				goto('/login?registered=true');
			} catch {
				authError = 'An unexpected error occurred. Please try again.';
				loading = false;
			}
		}
	});
</script>

<AuthCard
	title="Create an account"
	description="Enter your details to get started"
	{authError}
	footerText="Already have an account?"
	footerHref="/login"
	footerLinkLabel="Sign in"
>
	<form method="POST" use:enhance class="space-y-4">
		<AuthField
			id="name"
			label="Name"
			placeholder="Jane Doe"
			bind:value={$form.name}
			error={$errors.name}
		/>

		<AuthField
			id="email"
			label="Email"
			type="email"
			placeholder="you@example.com"
			bind:value={$form.email}
			error={$errors.email}
		/>

		<AuthField
			id="password"
			label="Password"
			type="password"
			bind:value={$form.password}
			error={$errors.password}
		/>

		<AuthField
			id="confirmPassword"
			label="Confirm password"
			type="password"
			bind:value={$form.confirmPassword}
			error={$errors.confirmPassword}
		/>

		<Button type="submit" class="w-full" disabled={loading}>
			{loading ? 'Creating account…' : 'Create account'}
		</Button>
	</form>

	<div class="relative">
		<Separator />
		<span
			class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-card px-2 text-xs text-muted-foreground"
		>
			OR
		</span>
	</div>

	<Button
		variant="outline"
		class="w-full"
		onclick={() => authClient.signIn.social({ provider: 'github', callbackURL: '/dashboard' })}
	>
		Continue with GitHub
	</Button>
</AuthCard>
