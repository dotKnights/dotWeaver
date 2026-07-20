<script lang="ts">
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client as zodClient } from 'sveltekit-superforms/adapters';
	import { loginSchema } from '$lib/schemas/auth';
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
		validators: zodClient(loginSchema),
		async onSubmit({ formData, cancel }) {
			cancel();
			authError = null;
			loading = true;

			try {
				const { error } = await authClient.signIn.email({
					email: formData.get('email') as string,
					password: formData.get('password') as string,
					callbackURL: '/dashboard'
				});

				if (error) {
					authError = error.message ?? 'Invalid email or password';
					loading = false;
					return;
				}

				loading = false;
				goto('/dashboard');
			} catch {
				authError = 'An unexpected error occurred. Please try again.';
				loading = false;
			}
		}
	});
</script>

<AuthCard
	title="Sign in"
	description="Enter your email and password to sign in"
	{authError}
	footerText="Don't have an account?"
	footerHref="/register"
	footerLinkLabel="Register"
>
	<form method="POST" use:enhance class="space-y-4">
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

		<Button type="submit" class="w-full" disabled={loading}>
			{loading ? 'Signing in…' : 'Sign in'}
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
	<Button
		variant="outline"
		class="w-full"
		onclick={() => authClient.signIn.social({ provider: 'google', callbackURL: '/dashboard' })}
	>
		Continue with Google
	</Button>
</AuthCard>
