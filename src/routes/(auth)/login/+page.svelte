<script lang="ts">
  import { superForm } from 'sveltekit-superforms'
  import { zod4Client as zodClient } from 'sveltekit-superforms/adapters'
  import { loginSchema } from '$lib/schemas/auth'
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

  const { form, errors, enhance } = superForm(data.form, {
    validators: zodClient(loginSchema),
    async onSubmit({ formData, cancel }) {
      cancel()
      authError = null
      loading = true

      const { error } = await authClient.signIn.email({
        email: formData.get('email') as string,
        password: formData.get('password') as string,
        callbackURL: '/dashboard',
      })

      if (error) {
        authError = error.message ?? 'Invalid email or password'
        loading = false
        return
      }

      goto('/dashboard')
    },
  })
</script>

<div class="flex min-h-screen items-center justify-center">
  <Card.Root class="w-full max-w-md">
    <Card.Header>
      <Card.Title>Sign in</Card.Title>
      <Card.Description>Enter your email and password to sign in</Card.Description>
    </Card.Header>
    <Card.Content class="space-y-4">
      {#if authError}
        <Alert.Root variant="destructive">
          <Alert.Description>{authError}</Alert.Description>
        </Alert.Root>
      {/if}

      <form method="POST" use:enhance class="space-y-4">
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

        <Button type="submit" class="w-full" disabled={loading}>
          {loading ? 'Signing in…' : 'Sign in'}
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
        Don't have an account?
        <a href="/register" class="text-foreground underline underline-offset-4">Register</a>
      </p>
    </Card.Footer>
  </Card.Root>
</div>
