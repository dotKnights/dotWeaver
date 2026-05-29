# Better Auth + Prisma Authentication — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Set up a full authentication system with Better Auth + Prisma (PostgreSQL), email/password + GitHub OAuth, shadcn-svelte UI, Superforms + Zod validation, and a protected `(app)` route group.

**Architecture:** Better Auth handles auth via `svelteKitHandler` in `hooks.server.ts`, which intercepts all `/api/auth/*` routes automatically. The Prisma adapter persists users/sessions/accounts to PostgreSQL. Login and register pages use Superforms for client-side validation display and Better Auth's browser client (`authClient`) for the actual API calls.

**Tech Stack:** SvelteKit 5, Better Auth, Prisma, PostgreSQL, shadcn-svelte, sveltekit-superforms, Zod, TypeScript, Tailwind v4

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `.env` | Create | DB URL, auth secret, GitHub credentials |
| `.env.example` | Create | Documentation of required env vars |
| `prisma/schema.prisma` | Create | Better Auth DB schema (user, session, account, verification) |
| `src/lib/server/prisma.ts` | Create | Prisma Client singleton |
| `src/lib/server/auth.ts` | Create | Better Auth instance config |
| `src/lib/auth-client.ts` | Create | Browser-side Better Auth client |
| `src/lib/schemas/auth.ts` | Create | Zod schemas for login + register |
| `src/lib/schemas/auth.test.ts` | Create | Unit tests for Zod schemas |
| `src/hooks.server.ts` | Create | svelteKitHandler + session → locals |
| `src/app.d.ts` | Modify | Add `locals.session` + `locals.user` types |
| `src/routes/(auth)/login/+page.server.ts` | Create | Load initial form state, redirect if already authed |
| `src/routes/(auth)/login/+page.svelte` | Create | Login form UI (shadcn Input/Button/Card) |
| `src/routes/(auth)/register/+page.server.ts` | Create | Load initial form state, redirect if already authed |
| `src/routes/(auth)/register/+page.svelte` | Create | Register form UI |
| `src/routes/(app)/+layout.server.ts` | Create | Session guard — redirect to /login if absent |
| `src/routes/(app)/dashboard/+page.svelte` | Create | Protected example page |

---

## Task 1: Install dependencies

**Files:** `package.json`, `bun.lock`

- [ ] **Step 1: Install runtime dependencies**

```bash
bun add better-auth @prisma/client sveltekit-superforms zod
```

Expected: packages added to `dependencies` in `package.json`

- [ ] **Step 2: Install Prisma CLI as dev dependency**

```bash
bun add -D prisma
```

Expected: `prisma` added to `devDependencies`

- [ ] **Step 3: Initialize shadcn-svelte**

```bash
bunx shadcn-svelte@latest init
```

Follow prompts. When asked about Tailwind CSS, confirm the existing `app.css` path. Accept defaults for everything else. If this fails with a Tailwind v4 error, try `bunx shadcn-svelte@next init` instead.

- [ ] **Step 4: Add required shadcn-svelte components**

```bash
bunx shadcn-svelte@latest add button input card label alert separator
```

Expected: components created in `src/lib/components/ui/`

- [ ] **Step 5: Commit**

```bash
git add package.json bun.lock src/lib/components
git commit -m "feat: install better-auth, prisma, superforms, shadcn-svelte"
```

---

## Task 2: Set up environment variables

**Files:** `.env`, `.env.example`

- [ ] **Step 1: Create `.env`**

```env
DATABASE_URL="postgres://dotnacer:root@localhost:5432/dotWeaver"
BETTER_AUTH_SECRET="replace-with-a-random-32+-character-secret-string"
BETTER_AUTH_URL="http://localhost:5173"
GITHUB_CLIENT_ID="your-github-oauth-app-client-id"
GITHUB_CLIENT_SECRET="your-github-oauth-app-client-secret"
```

To generate a secret: `openssl rand -base64 32`

> **GitHub OAuth App setup:** Go to https://github.com/settings/developers → "New OAuth App"
> - Homepage URL: `http://localhost:5173`
> - Authorization callback URL: `http://localhost:5173/api/auth/callback/github`
> Copy the Client ID and generate a Client Secret.

- [ ] **Step 2: Create `.env.example`**

```env
DATABASE_URL="postgres://user:password@localhost:5432/dbname"
BETTER_AUTH_SECRET="min-32-character-random-secret"
BETTER_AUTH_URL="http://localhost:5173"
GITHUB_CLIENT_ID=""
GITHUB_CLIENT_SECRET=""
```

- [ ] **Step 3: Verify `.gitignore` includes `.env`**

```bash
grep "^\.env$" .gitignore || echo ".env" >> .gitignore
```

- [ ] **Step 4: Commit**

```bash
git add .env.example .gitignore
git commit -m "chore: add env template and github oauth instructions"
```

---

## Task 3: Initialize Prisma and create schema

**Files:** `prisma/schema.prisma`

- [ ] **Step 1: Initialize Prisma**

```bash
bunx prisma init --datasource-provider postgresql
```

Expected: creates `prisma/schema.prisma` and appends `DATABASE_URL` hint to `.env` (already set — ignore the duplicate).

- [ ] **Step 2: Replace `prisma/schema.prisma` with the Better Auth schema**

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id            String    @id
  name          String
  email         String    @unique
  emailVerified Boolean
  image         String?
  createdAt     DateTime
  updatedAt     DateTime
  sessions      Session[]
  accounts      Account[]

  @@map("user")
}

model Session {
  id        String   @id
  expiresAt DateTime
  token     String   @unique
  createdAt DateTime
  updatedAt DateTime
  ipAddress String?
  userAgent String?
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@map("session")
}

model Account {
  id                    String    @id
  accountId             String
  providerId            String
  userId                String
  user                  User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  accessToken           String?
  refreshToken          String?
  idToken               String?
  accessTokenExpiresAt  DateTime?
  refreshTokenExpiresAt DateTime?
  scope                 String?
  password              String?
  createdAt             DateTime
  updatedAt             DateTime

  @@map("account")
}

model Verification {
  id         String    @id
  identifier String
  value      String
  expiresAt  DateTime
  createdAt  DateTime?
  updatedAt  DateTime?

  @@map("verification")
}
```

- [ ] **Step 3: Push schema to database**

```bash
bunx prisma db push
```

Expected output ends with:
```
Your database is now in sync with your Prisma schema.
✔ Generated Prisma Client
```

- [ ] **Step 4: Confirm Prisma Client was generated**

```bash
ls node_modules/.prisma/client/
```

Expected: `index.js`, `index.d.ts` and other generated files present.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat: add prisma schema with better-auth tables"
```

---

## Task 4: Create Prisma singleton and Better Auth instance

**Files:** `src/lib/server/prisma.ts`, `src/lib/server/auth.ts`

- [ ] **Step 1: Create `src/lib/server/prisma.ts`**

```ts
import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient }

export const prisma = globalForPrisma.prisma ?? new PrismaClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
```

- [ ] **Step 2: Create `src/lib/server/auth.ts`**

```ts
import { betterAuth } from 'better-auth'
import { prismaAdapter } from 'better-auth/adapters/prisma'
import { prisma } from './prisma'

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: 'postgresql' }),
  emailAndPassword: {
    enabled: true,
  },
  socialProviders: {
    github: {
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
    },
  },
})
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
bunx svelte-kit sync && bunx tsc --noEmit
```

Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add src/lib/server/
git commit -m "feat: add prisma singleton and better-auth instance"
```

---

## Task 5: Create auth client and update type declarations

**Files:** `src/lib/auth-client.ts`, `src/app.d.ts`

- [ ] **Step 1: Create `src/lib/auth-client.ts`**

```ts
import { createAuthClient } from 'better-auth/svelte'

export const authClient = createAuthClient({
  baseURL: import.meta.env.VITE_BETTER_AUTH_URL ?? 'http://localhost:5173',
})
```

- [ ] **Step 2: Update `src/app.d.ts`**

```ts
import type { Session, User } from 'better-auth/types'

declare global {
  namespace App {
    interface Locals {
      session: Session | null
      user: User | null
    }
  }
}

export {}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
bunx svelte-kit sync && bunx tsc --noEmit
```

Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add src/lib/auth-client.ts src/app.d.ts
git commit -m "feat: add auth browser client and locals type declarations"
```

---

## Task 6: Set up hooks.server.ts

**Files:** `src/hooks.server.ts`

- [ ] **Step 1: Create `src/hooks.server.ts`**

```ts
import { auth } from '$lib/server/auth'
import { svelteKitHandler } from 'better-auth/svelte-kit'
import { building } from '$app/environment'
import type { Handle } from '@sveltejs/kit'

export const handle: Handle = async ({ event, resolve }) => {
  const session = await auth.api.getSession({ headers: event.request.headers })
  event.locals.session = session?.session ?? null
  event.locals.user = session?.user ?? null

  return svelteKitHandler({ event, resolve, auth, building })
}
```

- [ ] **Step 2: Start dev server and verify no startup errors**

```bash
bun dev
```

Expected: server starts on `http://localhost:5173` with no errors in the terminal. Stop with Ctrl+C.

- [ ] **Step 3: Commit**

```bash
git add src/hooks.server.ts
git commit -m "feat: wire better-auth sveltekit handler in hooks.server.ts"
```

---

## Task 7: Create Zod schemas with TDD

**Files:** `src/lib/schemas/auth.ts`, `src/lib/schemas/auth.test.ts`

- [ ] **Step 1: Write the failing tests first — `src/lib/schemas/auth.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { loginSchema, registerSchema } from './auth'

describe('loginSchema', () => {
  it('accepts valid email and password', () => {
    const result = loginSchema.safeParse({ email: 'user@example.com', password: 'password123' })
    expect(result.success).toBe(true)
  })

  it('rejects invalid email', () => {
    const result = loginSchema.safeParse({ email: 'not-an-email', password: 'password123' })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0].path).toContain('email')
  })

  it('rejects password shorter than 8 characters', () => {
    const result = loginSchema.safeParse({ email: 'user@example.com', password: 'short' })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0].path).toContain('password')
  })
})

describe('registerSchema', () => {
  const valid = {
    name: 'Jane Doe',
    email: 'jane@example.com',
    password: 'password123',
    confirmPassword: 'password123',
  }

  it('accepts valid registration data', () => {
    expect(registerSchema.safeParse(valid).success).toBe(true)
  })

  it('rejects name shorter than 2 characters', () => {
    const result = registerSchema.safeParse({ ...valid, name: 'J' })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0].path).toContain('name')
  })

  it('rejects mismatched passwords', () => {
    const result = registerSchema.safeParse({ ...valid, confirmPassword: 'different123' })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0].path).toContain('confirmPassword')
  })

  it('rejects short password', () => {
    const result = registerSchema.safeParse({ ...valid, password: 'short', confirmPassword: 'short' })
    expect(result.success).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
bun run test:unit src/lib/schemas/auth.test.ts
```

Expected: all tests fail with `Cannot find module './auth'`

- [ ] **Step 3: Create `src/lib/schemas/auth.ts`**

```ts
import { z } from 'zod'

export const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
})

export const registerSchema = z
  .object({
    name: z.string().min(2, 'Name must be at least 2 characters'),
    email: z.string().email('Invalid email address'),
    password: z.string().min(8, 'Password must be at least 8 characters'),
    confirmPassword: z.string().min(8, 'Password must be at least 8 characters'),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords don't match",
    path: ['confirmPassword'],
  })

export type LoginSchema = typeof loginSchema
export type RegisterSchema = typeof registerSchema
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
bun run test:unit src/lib/schemas/auth.test.ts
```

Expected: all 7 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/lib/schemas/
git commit -m "feat: add zod auth schemas with tests"
```

---

## Task 8: Create login page

**Files:** `src/routes/(auth)/login/+page.server.ts`, `src/routes/(auth)/login/+page.svelte`

- [ ] **Step 1: Create `src/routes/(auth)/login/+page.server.ts`**

```ts
import { superValidate } from 'sveltekit-superforms'
import { zod } from 'sveltekit-superforms/adapters'
import { loginSchema } from '$lib/schemas/auth'
import { auth } from '$lib/server/auth'
import { redirect } from '@sveltejs/kit'
import type { PageServerLoad } from './$types'

export const load: PageServerLoad = async ({ locals }) => {
  if (locals.session) redirect(303, '/dashboard')
  return { form: await superValidate(zod(loginSchema)) }
}
```

- [ ] **Step 2: Create `src/routes/(auth)/login/+page.svelte`**

```svelte
<script lang="ts">
  import { superForm } from 'sveltekit-superforms'
  import { zodClient } from 'sveltekit-superforms/adapters'
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
```

- [ ] **Step 3: Run svelte-autofixer to check for issues**

Check the page with the Svelte MCP `svelte-autofixer` tool on both files.

- [ ] **Step 4: Start dev server and verify the login page renders**

```bash
bun dev
```

Navigate to `http://localhost:5173/login`. The page should render the login card with email/password fields and GitHub button. No console errors.

- [ ] **Step 5: Commit**

```bash
git add src/routes/\(auth\)/login/
git commit -m "feat: add login page with superforms validation and github oauth"
```

---

## Task 9: Create register page

**Files:** `src/routes/(auth)/register/+page.server.ts`, `src/routes/(auth)/register/+page.svelte`

- [ ] **Step 1: Create `src/routes/(auth)/register/+page.server.ts`**

```ts
import { superValidate } from 'sveltekit-superforms'
import { zod } from 'sveltekit-superforms/adapters'
import { registerSchema } from '$lib/schemas/auth'
import { redirect } from '@sveltejs/kit'
import type { PageServerLoad } from './$types'

export const load: PageServerLoad = async ({ locals }) => {
  if (locals.session) redirect(303, '/dashboard')
  return { form: await superValidate(zod(registerSchema)) }
}
```

- [ ] **Step 2: Create `src/routes/(auth)/register/+page.svelte`**

```svelte
<script lang="ts">
  import { superForm } from 'sveltekit-superforms'
  import { zodClient } from 'sveltekit-superforms/adapters'
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
```

- [ ] **Step 3: Run svelte-autofixer on both files**

Use the Svelte MCP `svelte-autofixer` tool on `+page.svelte`.

- [ ] **Step 4: Start dev server and verify the register page renders**

Navigate to `http://localhost:5173/register`. The page should render with name/email/password/confirm fields and GitHub button. No console errors.

- [ ] **Step 5: Commit**

```bash
git add src/routes/\(auth\)/register/
git commit -m "feat: add register page with superforms validation"
```

---

## Task 10: Create protected (app) layout + dashboard

**Files:** `src/routes/(app)/+layout.server.ts`, `src/routes/(app)/dashboard/+page.svelte`

- [ ] **Step 1: Write the failing test for the protected layout**

Create `src/routes/(app)/+layout.server.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'

// Mock SvelteKit redirect
vi.mock('@sveltejs/kit', () => ({
  redirect: vi.fn((status, url) => {
    const error = new Error(`Redirect to ${url}`)
    ;(error as any).status = status
    ;(error as any).location = url
    throw error
  }),
}))

// Import after mock
const { load } = await import('./+layout.server')

describe('(app) layout guard', () => {
  it('redirects to /login when no session', async () => {
    const event = { locals: { session: null, user: null } } as any
    await expect(load(event)).rejects.toThrow('Redirect to /login')
  })

  it('returns user when session exists', async () => {
    const user = { id: '1', name: 'Jane', email: 'jane@example.com' }
    const event = { locals: { session: { id: 'sess1' }, user } } as any
    const result = await load(event)
    expect(result).toEqual({ user })
  })
})
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
bun run test:unit src/routes/\\(app\\)/+layout.server.test.ts
```

Expected: fails with module not found

- [ ] **Step 3: Create `src/routes/(app)/+layout.server.ts`**

```ts
import { redirect } from '@sveltejs/kit'
import type { LayoutServerLoad } from './$types'

export const load: LayoutServerLoad = async ({ locals }) => {
  if (!locals.session) redirect(303, '/login')
  return { user: locals.user }
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
bun run test:unit src/routes/\\(app\\)/+layout.server.test.ts
```

Expected: both tests pass

- [ ] **Step 5: Create `src/routes/(app)/dashboard/+page.svelte`**

```svelte
<script lang="ts">
  import { authClient } from '$lib/auth-client'
  import { goto } from '$app/navigation'
  import { Button } from '$lib/components/ui/button'

  let { data } = $props()

  async function signOut() {
    await authClient.signOut()
    goto('/login')
  }
</script>

<div class="flex min-h-screen flex-col items-center justify-center gap-4">
  <h1 class="text-2xl font-bold">Dashboard</h1>
  {#if data.user}
    <p class="text-muted-foreground">Welcome, {data.user.name}</p>
  {/if}
  <Button variant="outline" onclick={signOut}>Sign out</Button>
</div>
```

- [ ] **Step 6: Verify protected route redirects in the browser**

```bash
bun dev
```

Navigate to `http://localhost:5173/dashboard` while NOT logged in. Should redirect to `/login`. Sign in, then navigate to `/dashboard` — should show the dashboard with user's name.

- [ ] **Step 7: Commit**

```bash
git add src/routes/\(app\)/
git commit -m "feat: add protected app layout and dashboard page"
```

---

## Task 11: End-to-end smoke test

- [ ] **Step 1: Run all unit tests**

```bash
bun run test:unit -- --run
```

Expected: all tests pass (Zod schemas + layout guard)

- [ ] **Step 2: Check TypeScript**

```bash
bunx svelte-kit sync && bunx tsc --noEmit
```

Expected: no errors

- [ ] **Step 3: Manual browser verification**

With `bun dev` running:

1. Go to `/register` → create an account with email/password → should redirect to `/login`
2. Go to `/login` → sign in → should redirect to `/dashboard` showing your name
3. Click "Sign out" → should redirect to `/login`
4. Go directly to `/dashboard` without session → should redirect to `/login`
5. Go to `/login` → click "Continue with GitHub" → complete GitHub OAuth → should land on `/dashboard`

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat: complete better-auth setup with prisma, shadcn-svelte, and superforms"
```
