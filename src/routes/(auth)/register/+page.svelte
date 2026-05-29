<script lang="ts">
  import { superForm } from 'sveltekit-superforms'
  import { zod4Client as zodClient } from 'sveltekit-superforms/adapters'
  import { registerSchema } from '$lib/schemas/auth'
  import { authClient } from '$lib/auth-client'
  import { goto } from '$app/navigation'
  import * as Card from '$lib/components/ui/card'
  import { Input } from '$lib/components/ui/input'
  import { Button } from '$lib/components/ui/button'
  import { Label } from '$lib/components/ui/label'
  import * as Alert from '$lib/components/ui/alert'
  import { Separator } from '$lib/components/ui/separator'

  let { data } = $props()
  let authError = $state<string | null>(null)
  let loading = $state(false)

  // svelte-ignore state_referenced_locally
  const { form, errors, enhance } = superForm(data.form, {
    validators: zodClient(registerSchema),
    async onSubmit({ formData, cancel }) {
      cancel()
      authError = null
      loading = true

      const { error } = await authClient.signUp.email({
        name: formData.get('name') as string,
        email: formData.get('email') as string,
        password: formData.get('password') as string,
        callbackURL: '/dashboard',
      })

      if (error) {
        authError = error.message ?? 'Could not create account. Please try again.'
        loading = false
        return
      }

      goto('/login?registered=true')
    },
  })
</script>

<div class="flex min-h-screen items-center justify-center">
  <Card.Root class="w-full max-w-md">
    <Card.Header>
      <Card.Title>Create an account</Card.Title>
      <Card.Description>Enter your details to get started</Card.Description>
    </Card.Header>
    <Card.Content class="space-y-4">
      {#if authError}
        <Alert.Root variant="destructive">
          <Alert.Description>{authError}</Alert.Description>
        </Alert.Root>
      {/if}

      <form method="POST" use:enhance class="space-y-4">
        <div class="space-y-2">
          <Label for="name">Name</Label>
          <Input
            id="name"
            name="name"
            type="text"
            placeholder="Jane Doe"
            bind:value={$form.name}
            aria-invalid={$errors.name ? 'true' : undefined}
          />
          {#if $errors.name}
            <p class="text-destructive text-sm">{$errors.name}</p>
          {/if}
        </div>

        <div class="space-y-2">
          <Label for="email">Email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            placeholder="you@example.com"
            bind:value={$form.email}
            aria-invalid={$errors.email ? 'true' : undefined}
          />
          {#if $errors.email}
            <p class="text-destructive text-sm">{$errors.email}</p>
          {/if}
        </div>

        <div class="space-y-2">
          <Label for="password">Password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            bind:value={$form.password}
            aria-invalid={$errors.password ? 'true' : undefined}
          />
          {#if $errors.password}
            <p class="text-destructive text-sm">{$errors.password}</p>
          {/if}
        </div>

        <div class="space-y-2">
          <Label for="confirmPassword">Confirm password</Label>
          <Input
            id="confirmPassword"
            name="confirmPassword"
            type="password"
            bind:value={$form.confirmPassword}
            aria-invalid={$errors.confirmPassword ? 'true' : undefined}
          />
          {#if $errors.confirmPassword}
            <p class="text-destructive text-sm">{$errors.confirmPassword}</p>
          {/if}
        </div>

        <Button type="submit" class="w-full" disabled={loading}>
          {loading ? 'Creating account…' : 'Create account'}
        </Button>
      </form>

      <div class="relative">
        <Separator />
        <span class="bg-card text-muted-foreground absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 px-2 text-xs">
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
    </Card.Content>
    <Card.Footer>
      <p class="text-muted-foreground text-sm">
        Already have an account?
        <a href="/login" class="text-foreground underline underline-offset-4">Sign in</a>
      </p>
    </Card.Footer>
  </Card.Root>
</div>
