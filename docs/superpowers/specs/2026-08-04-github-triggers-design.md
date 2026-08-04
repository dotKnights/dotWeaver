# GitHub Triggers — Feature Design Specification

**Document:** `docs/superpowers/specs/2026-08-04-github-triggers-design.md`  
**Date:** 2026-08-04  
**Status:** Draft v1  
**Author:** dotWeaver engineering  

---

## Table of Contents

1. [Overview & Goals](#1-overview--goals)
2. [Data Model](#2-data-model)
3. [API Surface](#3-api-surface)
4. [Webhook Handler Logic](#4-webhook-handler-logic)
5. [Prompt Template Rendering](#5-prompt-template-rendering)
6. [UI Flows](#6-ui-flows)
7. [Security Considerations](#7-security-considerations)
8. [Error Handling](#8-error-handling)
9. [Testing Strategy](#9-testing-strategy)
10. [Out of Scope / Future Work](#10-out-of-scope--future-work)

---

## 1. Overview & Goals

### Problem

Teams using dotWeaver currently must manually create a Run through the UI whenever they want an AI agent to act on a GitHub event (new issue, review request, etc.). This creates friction and makes it impossible to respond automatically to common patterns like "assign this bug to an AI agent when it's labelled `ai-fix`."

### Solution

**GitHub Triggers** is a project-level configuration feature that maps GitHub webhook events to automatic Run creation. A trigger defines:

- **When:** which GitHub event type fires it
- **Conditions:** filter criteria that must be met for the trigger to activate
- **Run template:** what agent, model, base branch, and prompt to use when creating the resulting Run

A single GitHub webhook is registered per organization. dotWeaver receives all events, verifies the HMAC signature, and then evaluates project-level triggers to determine which (if any) runs to create.

### v1 Supported Event Types

| Event | GitHub `X-GitHub-Event` header | Trigger condition |
|---|---|---|
| Issue opened | `issues` (action: `opened`) | Issue has a specific label |
| Issue comment created | `issue_comment` (action: `created`) | Issue has a label + optional keyword in comment body |
| PR review submitted | `pull_request_review` (action: `submitted`) | Review state is `changes_requested` + optional base branch pattern |

### Non-Goals (v1)

- `push` / branch creation events  
- PR `opened` / `merged` events  
- Cron / scheduled triggers  
- Deduplication of multiple triggers firing simultaneously  
- Per-trigger rate limiting  

---

## 2. Data Model

### 2.1 New Prisma Models

Add the following to `prisma/schema.prisma`:

```prisma
// ─── Enums ───────────────────────────────────────────────────────────────────

enum GithubTriggerEventType {
  ISSUES_OPENED
  ISSUE_COMMENT_CREATED
  PULL_REQUEST_REVIEW_SUBMITTED
}

enum GithubWebhookDeliveryStatus {
  RECEIVED      // Payload accepted, not yet processed
  PROCESSING    // Handler is actively evaluating triggers
  COMPLETED     // All matching triggers were processed (runs created or none matched)
  FAILED        // Processing error; see errorMessage
  SKIPPED       // Signature invalid or event type not handled
}

// ─── GithubTrigger ───────────────────────────────────────────────────────────

/// A project-level rule that maps a GitHub event to an automatic Run.
model GithubTrigger {
  id             String                  @id @default(cuid())
  createdAt      DateTime                @default(now())
  updatedAt      DateTime                @updatedAt

  // Ownership
  projectId      String
  project        Project                 @relation(fields: [projectId], references: [id], onDelete: Cascade)
  organizationId String
  organization   Organization            @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  // Created by a human member
  createdById    String
  createdBy      User                    @relation(fields: [createdById], references: [id])

  // Identity
  name           String                  // Human-readable name, e.g. "Auto-fix labelled bugs"
  description    String?                 // Optional longer description

  // Event
  eventType      GithubTriggerEventType

  // ── Conditions (nullable fields; validated by business logic per eventType) ──

  /// For ISSUES_OPENED and ISSUE_COMMENT_CREATED:
  /// The exact GitHub label name the issue must carry (required for both).
  labelFilter    String?

  /// For ISSUE_COMMENT_CREATED only:
  /// If set, the comment body must contain this string (case-insensitive prefix match).
  /// E.g. "/ai-fix"
  commentKeyword String?

  /// For PULL_REQUEST_REVIEW_SUBMITTED only:
  /// Glob pattern matched against the PR's base branch name.
  /// E.g. "main", "release/*". If null, any base branch matches.
  baseBranchPattern String?

  // ── Run Template ─────────────────────────────────────────────────────────────

  /// "claude" | "codex"
  agent          String
  /// Model identifier, e.g. "claude-sonnet-4-5", "gpt-4o"
  model          String
  /// Base branch for the resulting Run. Supports "{{default_branch}}".
  runBaseBranch  String                  @default("{{default_branch}}")
  /// Prompt template with variable placeholders (see §5).
  promptTemplate String                  @db.Text

  // ── State ────────────────────────────────────────────────────────────────────

  enabled        Boolean                 @default(true)

  runs           Run[]                   @relation("TriggerRuns")

  @@index([projectId])
  @@index([organizationId])
  @@index([eventType, enabled])
}

// ─── GithubWebhookDelivery ───────────────────────────────────────────────────

/// Idempotency log for every webhook payload received from GitHub.
/// GitHub retries deliveries; this table prevents duplicate Run creation.
model GithubWebhookDelivery {
  id              String                       @id @default(cuid())
  receivedAt      DateTime                     @default(now())
  processedAt     DateTime?

  /// Value of the X-GitHub-Delivery header (UUID from GitHub).
  githubDeliveryId String                      @unique

  /// Value of X-GitHub-Event header, e.g. "issues", "issue_comment".
  eventName       String
  /// The "action" field inside the payload body, e.g. "opened", "created".
  action          String?

  /// Which organization this webhook belongs to (looked up via webhook secret).
  organizationId  String?
  organization    Organization?               @relation(fields: [organizationId], references: [id])

  /// Raw JSON payload (stored for debugging / replay).
  payload         Json

  status          GithubWebhookDeliveryStatus  @default(RECEIVED)
  errorMessage    String?                      @db.Text

  /// Runs that were created as a result of this delivery.
  runsCreated     Run[]                        @relation("DeliveryRuns")

  @@index([organizationId])
  @@index([status])
  @@index([receivedAt])
}
```

### 2.2 Amendments to Existing Models

```prisma
// In model Organization — add:
webhookSecret       String?           // HMAC-SHA256 signing secret for GitHub webhook
githubTriggers      GithubTrigger[]
webhookDeliveries   GithubWebhookDelivery[]

// In model Project — add:
githubTriggers      GithubTrigger[]

// In model Run — add:
// The trigger that created this run (null for manually-created runs)
githubTriggerId     String?
githubTrigger       GithubTrigger?    @relation("TriggerRuns", fields: [githubTriggerId], references: [id])

// The webhook delivery that caused this run (null for manually-created runs)
webhookDeliveryId   String?
webhookDelivery     GithubWebhookDelivery? @relation("DeliveryRuns", fields: [webhookDeliveryId], references: [id])
```

### 2.3 Migration Notes

- `webhookSecret` on `Organization` should be nullable and encrypted at rest (use the same pattern as existing GitHub tokens). Store as a reversible encrypted string; never return it in API responses.  
- `Run.githubTriggerId` and `Run.webhookDeliveryId` are nullable to preserve backwards compatibility with existing manually-created runs.
- Add a database-level unique constraint on `GithubWebhookDelivery.githubDeliveryId` — this is the primary idempotency guard.

---

## 3. API Surface

### 3.1 Zod Schemas (`src/lib/schemas/github-triggers.ts`)

```typescript
import { z } from 'zod';

// ── Enums ─────────────────────────────────────────────────────────────────────

export const GithubTriggerEventTypeSchema = z.enum([
  'ISSUES_OPENED',
  'ISSUE_COMMENT_CREATED',
  'PULL_REQUEST_REVIEW_SUBMITTED',
]);
export type GithubTriggerEventType = z.infer<typeof GithubTriggerEventTypeSchema>;

// ── Condition schemas (discriminated by eventType) ────────────────────────────

export const IssuesOpenedConditionsSchema = z.object({
  eventType: z.literal('ISSUES_OPENED'),
  labelFilter: z.string().min(1, 'Label is required'),
  commentKeyword: z.undefined().optional(),
  baseBranchPattern: z.undefined().optional(),
});

export const IssueCommentCreatedConditionsSchema = z.object({
  eventType: z.literal('ISSUE_COMMENT_CREATED'),
  labelFilter: z.string().min(1, 'Label is required'),
  commentKeyword: z.string().min(1).optional(),
  baseBranchPattern: z.undefined().optional(),
});

export const PullRequestReviewSubmittedConditionsSchema = z.object({
  eventType: z.literal('PULL_REQUEST_REVIEW_SUBMITTED'),
  labelFilter: z.undefined().optional(),
  commentKeyword: z.undefined().optional(),
  baseBranchPattern: z.string().optional(), // glob, e.g. "main" or "release/*"
});

export const TriggerConditionsSchema = z.discriminatedUnion('eventType', [
  IssuesOpenedConditionsSchema,
  IssueCommentCreatedConditionsSchema,
  PullRequestReviewSubmittedConditionsSchema,
]);

// ── Run template ──────────────────────────────────────────────────────────────

export const TriggerRunTemplateSchema = z.object({
  agent: z.enum(['claude', 'codex']),
  model: z.string().min(1),
  runBaseBranch: z.string().min(1).default('{{default_branch}}'),
  promptTemplate: z.string().min(1, 'Prompt template is required'),
});

// ── Full trigger schemas ───────────────────────────────────────────────────────

export const CreateGithubTriggerInputSchema = z.object({
  projectId: z.string().cuid(),
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  enabled: z.boolean().default(true),
  conditions: TriggerConditionsSchema,
  runTemplate: TriggerRunTemplateSchema,
});
export type CreateGithubTriggerInput = z.infer<typeof CreateGithubTriggerInputSchema>;

export const UpdateGithubTriggerInputSchema = CreateGithubTriggerInputSchema
  .partial()
  .extend({ triggerId: z.string().cuid() });
export type UpdateGithubTriggerInput = z.infer<typeof UpdateGithubTriggerInputSchema>;

export const GithubTriggerSchema = z.object({
  id: z.string().cuid(),
  createdAt: z.date(),
  updatedAt: z.date(),
  projectId: z.string().cuid(),
  organizationId: z.string().cuid(),
  createdById: z.string().cuid(),
  name: z.string(),
  description: z.string().nullable(),
  eventType: GithubTriggerEventTypeSchema,
  labelFilter: z.string().nullable(),
  commentKeyword: z.string().nullable(),
  baseBranchPattern: z.string().nullable(),
  agent: z.string(),
  model: z.string(),
  runBaseBranch: z.string(),
  promptTemplate: z.string(),
  enabled: z.boolean(),
});
export type GithubTrigger = z.infer<typeof GithubTriggerSchema>;

// ── Webhook secret management ─────────────────────────────────────────────────

export const SetWebhookSecretInputSchema = z.object({
  organizationId: z.string().cuid(),
  secret: z.string().min(16, 'Secret must be at least 16 characters'),
});
export type SetWebhookSecretInput = z.infer<typeof SetWebhookSecretInputSchema>;
```

### 3.2 RFC Remote Functions (`src/lib/rfc/github-triggers.remote.ts`)

Following the existing query/command pattern used throughout dotWeaver:

```typescript
import 'server-only';
import { z } from 'zod';
import { defineQuery, defineCommand } from '$lib/rfc/define';
import {
  CreateGithubTriggerInputSchema,
  UpdateGithubTriggerInputSchema,
  GithubTriggerSchema,
  SetWebhookSecretInputSchema,
} from '$lib/schemas/github-triggers';
import { githubTriggersService } from '$lib/server/github-triggers/service';
import { requireActor, requireProjectPermission } from '$lib/server/authz';

// ── Queries ───────────────────────────────────────────────────────────────────

/**
 * List all triggers for a project. Requires project:read permission.
 */
export const listGithubTriggersQuery = defineQuery(
  z.object({ projectId: z.string().cuid() }),
  z.array(GithubTriggerSchema),
  async (input, ctx) => {
    const actor = await requireActor(ctx);
    await requireProjectPermission(actor, input.projectId, 'read');
    return githubTriggersService.listForProject(input.projectId);
  },
);

/**
 * Get a single trigger by ID. Requires project:read permission on the trigger's project.
 */
export const getGithubTriggerQuery = defineQuery(
  z.object({ triggerId: z.string().cuid() }),
  GithubTriggerSchema,
  async (input, ctx) => {
    const actor = await requireActor(ctx);
    const trigger = await githubTriggersService.getById(input.triggerId);
    await requireProjectPermission(actor, trigger.projectId, 'read');
    return trigger;
  },
);

// ── Commands ──────────────────────────────────────────────────────────────────

/**
 * Create a new trigger for a project. Requires project:write permission.
 */
export const createGithubTriggerCommand = defineCommand(
  CreateGithubTriggerInputSchema,
  GithubTriggerSchema,
  async (input, ctx) => {
    const actor = await requireActor(ctx);
    await requireProjectPermission(actor, input.projectId, 'write');
    return githubTriggersService.create(input, actor.id);
  },
);

/**
 * Update an existing trigger. Requires project:write permission.
 */
export const updateGithubTriggerCommand = defineCommand(
  UpdateGithubTriggerInputSchema,
  GithubTriggerSchema,
  async (input, ctx) => {
    const actor = await requireActor(ctx);
    const trigger = await githubTriggersService.getById(input.triggerId);
    await requireProjectPermission(actor, trigger.projectId, 'write');
    return githubTriggersService.update(input);
  },
);

/**
 * Delete a trigger. Requires project:write permission.
 */
export const deleteGithubTriggerCommand = defineCommand(
  z.object({ triggerId: z.string().cuid() }),
  z.object({ success: z.boolean() }),
  async (input, ctx) => {
    const actor = await requireActor(ctx);
    const trigger = await githubTriggersService.getById(input.triggerId);
    await requireProjectPermission(actor, trigger.projectId, 'write');
    await githubTriggersService.delete(input.triggerId);
    return { success: true };
  },
);

/**
 * Toggle a trigger's enabled state. Requires project:write permission.
 */
export const toggleGithubTriggerCommand = defineCommand(
  z.object({ triggerId: z.string().cuid(), enabled: z.boolean() }),
  GithubTriggerSchema,
  async (input, ctx) => {
    const actor = await requireActor(ctx);
    const trigger = await githubTriggersService.getById(input.triggerId);
    await requireProjectPermission(actor, trigger.projectId, 'write');
    return githubTriggersService.setEnabled(input.triggerId, input.enabled);
  },
);

/**
 * Store or rotate the GitHub webhook secret for an organization.
 * Requires organization:admin permission.
 */
export const setWebhookSecretCommand = defineCommand(
  SetWebhookSecretInputSchema,
  z.object({ success: z.boolean() }),
  async (input, ctx) => {
    const actor = await requireActor(ctx);
    await requireOrgAdminPermission(actor, input.organizationId);
    await githubTriggersService.setWebhookSecret(input.organizationId, input.secret);
    return { success: true };
  },
);

/**
 * Check whether a webhook secret has been configured for an org
 * (returns boolean, never the secret itself).
 */
export const getWebhookSecretStatusQuery = defineQuery(
  z.object({ organizationId: z.string().cuid() }),
  z.object({ configured: z.boolean() }),
  async (input, ctx) => {
    const actor = await requireActor(ctx);
    await requireOrgAdminPermission(actor, input.organizationId);
    const configured = await githubTriggersService.hasWebhookSecret(input.organizationId);
    return { configured };
  },
);
```

### 3.3 Webhook Endpoint (`src/routes/api/github/webhook/+server.ts`)

This route is **not** protected by Better Auth middleware. Authentication is solely via HMAC-SHA256 signature verification.

```typescript
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { webhookHandlerService } from '$lib/server/github-triggers/webhook-handler';

export const POST: RequestHandler = async ({ request }) => {
  // Read raw body bytes — must be done before any parsing
  const rawBody = await request.text();

  const headers = {
    signature: request.headers.get('x-hub-signature-256') ?? '',
    event: request.headers.get('x-github-event') ?? '',
    deliveryId: request.headers.get('x-github-delivery') ?? '',
  };

  // Delegate all logic to the service (keeps handler thin and testable)
  const result = await webhookHandlerService.handle({
    rawBody,
    headers,
  });

  // GitHub expects 200 for successful receipt regardless of processing outcome.
  // Return 400 only for invalid signature (GitHub will not retry on 400).
  if (result.status === 'invalid_signature') {
    return json({ error: 'Invalid signature' }, { status: 400 });
  }

  return json({ received: true, deliveryId: result.deliveryId }, { status: 200 });
};
```

> **Important:** SvelteKit's `+server.ts` for this route must **not** import or reference any Better Auth session/cookie utilities. The route must be reachable without a session cookie.

---

## 4. Webhook Handler Logic

### 4.1 Service: `src/lib/server/github-triggers/webhook-handler.ts`

The handler follows a strict sequential pipeline. Each step is described below.

```typescript
export interface WebhookHandleInput {
  rawBody: string;
  headers: {
    signature: string;  // "sha256=<hex>"
    event: string;      // "issues" | "issue_comment" | "pull_request_review"
    deliveryId: string; // UUID from GitHub
  };
}

export type WebhookHandleResult =
  | { status: 'invalid_signature' }
  | { status: 'duplicate'; deliveryId: string }
  | { status: 'skipped'; deliveryId: string; reason: string }
  | { status: 'completed'; deliveryId: string; runsCreated: string[] }
  | { status: 'failed'; deliveryId: string; error: string };
```

### 4.2 Pipeline

```
  GitHub POST /api/github/webhook
          │
          ▼
  ┌───────────────────────────────┐
  │ 1. HMAC Signature Verification│  ← fail → 400 Invalid Signature
  └───────────┬───────────────────┘
              │
              ▼
  ┌───────────────────────────────┐
  │ 2. Idempotency Check          │  ← duplicate X-GitHub-Delivery → 200 (no-op)
  └───────────┬───────────────────┘
              │
              ▼
  ┌───────────────────────────────┐
  │ 3. Organization Lookup        │  ← no org with matching secret → SKIPPED
  └───────────┬───────────────────┘
              │
              ▼
  ┌───────────────────────────────┐
  │ 4. Event Parsing              │  ← unhandled event type → SKIPPED
  └───────────┬───────────────────┘
              │
              ▼
  ┌───────────────────────────────┐
  │ 5. Trigger Rule Matching      │  ← for each project in org
  └───────────┬───────────────────┘
              │  (list of matching triggers)
              ▼
  ┌───────────────────────────────┐
  │ 6. Run Creation               │  ← for each matched trigger
  └───────────┬───────────────────┘
              │
              ▼
  ┌───────────────────────────────┐
  │ 7. Delivery Record Update     │  → COMPLETED / FAILED
  └───────────────────────────────┘
```

#### Step 1 — HMAC Signature Verification

```typescript
async function verifySignature(
  rawBody: string,
  signatureHeader: string,
  secret: string,
): Promise<boolean> {
  // GitHub sends "sha256=<hex>"
  const [algorithm, receivedHex] = signatureHeader.split('=');
  if (algorithm !== 'sha256' || !receivedHex) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));
  const expectedHex = Buffer.from(sig).toString('hex');

  // Constant-time comparison to prevent timing attacks
  return timingSafeEqual(
    Buffer.from(receivedHex, 'hex'),
    Buffer.from(expectedHex, 'hex'),
  );
}
```

**Key implementation notes:**
- Use `crypto.subtle` (Web Crypto API — available in Bun) for HMAC; do NOT use Node's `crypto.createHmac` (incompatible with Bun's edge runtime requirements).
- Always use a constant-time comparison (`timingSafeEqual` or equivalent) to prevent timing-based secret oracle attacks.
- The raw body bytes must not be parsed or modified before signature verification. Read as text, verify, then parse as JSON.

#### Step 2 — Idempotency Check

Before any processing, attempt to insert a `GithubWebhookDelivery` record with the `githubDeliveryId` from the `X-GitHub-Delivery` header. Because this column has a `@unique` constraint, a duplicate delivery will cause a Prisma unique constraint violation. Catch that specific error and return a `duplicate` result with 200 status.

```typescript
try {
  delivery = await prisma.githubWebhookDelivery.create({
    data: {
      githubDeliveryId: headers.deliveryId,
      eventName: headers.event,
      action: payload.action ?? null,
      payload: payload,
      status: 'RECEIVED',
    },
  });
} catch (e) {
  if (isPrismaUniqueConstraintError(e)) {
    return { status: 'duplicate', deliveryId: headers.deliveryId };
  }
  throw e;
}
```

#### Step 3 — Organization Lookup

The webhook URL is shared for all organizations. We identify which org the payload belongs to by looking up the organization whose `webhookSecret` was used to sign the payload.

Because signature verification already happened against all org secrets (see §7.1 for the multi-tenant consideration), we can look up the org by checking which stored secret was used:

```typescript
// Look up all orgs that have a webhookSecret configured.
// For each, attempt signature verification.
// Return the first match.
// In practice, the GitHub-registered webhook per org sends to a
// per-org URL: POST /api/github/webhook?orgId=<cuid>
// This makes org lookup O(1) — see §7.2 for the recommended approach.
```

> **Recommended approach (§7.2):** Include the organization ID as a query parameter in the webhook URL registered on GitHub: `https://app.dotweaver.dev/api/github/webhook?orgId=<orgId>`. This allows O(1) org lookup. The HMAC verification still runs against that specific org's secret, so a tampered `orgId` will fail signature verification.

#### Step 4 — Event Parsing

Parse the raw JSON payload into a typed structure. Only three event types are handled in v1:

```typescript
type ParsedEvent =
  | { kind: 'issues_opened'; issue: GithubIssue; repo: GithubRepo }
  | { kind: 'issue_comment_created'; issue: GithubIssue; comment: GithubComment; repo: GithubRepo }
  | { kind: 'pull_request_review_submitted'; pr: GithubPR; review: GithubReview; repo: GithubRepo }
  | { kind: 'unhandled'; eventName: string; action: string | null };

interface GithubIssue {
  number: number;
  title: string;
  body: string | null;
  labels: Array<{ name: string }>;
  html_url: string;
}

interface GithubComment {
  body: string;
  html_url: string;
  user: { login: string };
}

interface GithubPR {
  number: number;
  title: string;
  body: string | null;
  base: { ref: string }; // base branch
  head: { ref: string };
  html_url: string;
}

interface GithubReview {
  state: 'approved' | 'changes_requested' | 'commented';
  body: string | null;
  html_url: string;
  user: { login: string };
}

interface GithubRepo {
  id: number;        // GitHub repo ID (matches Project.githubRepoId)
  full_name: string;
  default_branch: string;
}
```

Use Zod schemas to parse these structures. A parse failure should mark the delivery as `FAILED` with the parse error message.

#### Step 5 — Trigger Rule Matching

For a given parsed event and organization, find the project that owns the repository (via `Project.githubRepoId === event.repo.id`), then evaluate all enabled triggers for that project against the event:

```typescript
async function matchTriggers(
  event: ParsedEvent,
  project: Project,
): Promise<GithubTrigger[]> {
  const triggers = await prisma.githubTrigger.findMany({
    where: { projectId: project.id, enabled: true },
  });

  return triggers.filter((trigger) => matchesTrigger(trigger, event));
}

function matchesTrigger(trigger: GithubTrigger, event: ParsedEvent): boolean {
  switch (trigger.eventType) {
    case 'ISSUES_OPENED': {
      if (event.kind !== 'issues_opened') return false;
      return hasLabel(event.issue.labels, trigger.labelFilter!);
    }

    case 'ISSUE_COMMENT_CREATED': {
      if (event.kind !== 'issue_comment_created') return false;
      if (!hasLabel(event.issue.labels, trigger.labelFilter!)) return false;
      if (trigger.commentKeyword) {
        // Case-insensitive substring match
        return event.comment.body
          .toLowerCase()
          .includes(trigger.commentKeyword.toLowerCase());
      }
      return true;
    }

    case 'PULL_REQUEST_REVIEW_SUBMITTED': {
      if (event.kind !== 'pull_request_review_submitted') return false;
      if (event.review.state !== 'changes_requested') return false;
      if (trigger.baseBranchPattern) {
        return matchesGlob(event.pr.base.ref, trigger.baseBranchPattern);
      }
      return true;
    }

    default:
      return false;
  }
}

function hasLabel(
  labels: Array<{ name: string }>,
  labelFilter: string,
): boolean {
  return labels.some(
    (l) => l.name.toLowerCase() === labelFilter.toLowerCase(),
  );
}
```

**Glob matching** for `baseBranchPattern`: use the `micromatch` package (already a common dependency in Node/Bun ecosystems). Supported patterns: `main`, `release/*`, `v[0-9]*`.

#### Step 6 — Run Creation

For each matched trigger, render the prompt template (§5) and call the existing `startRunForOrg` service:

```typescript
for (const trigger of matchedTriggers) {
  const prompt = renderPromptTemplate(trigger.promptTemplate, event);
  const baseBranch = resolveBaseBranch(trigger.runBaseBranch, event.repo.default_branch);

  try {
    const run = await startRunForOrg({
      projectId: trigger.projectId,
      organizationId: trigger.organizationId,
      prompt,
      agent: trigger.agent,
      model: trigger.model,
      baseBranch,
      // Link back to trigger and delivery for audit trail
      githubTriggerId: trigger.id,
      webhookDeliveryId: delivery.id,
    });
    createdRunIds.push(run.id);
  } catch (runError) {
    // Log the error but continue processing other triggers
    logger.error('Failed to create run for trigger', {
      triggerId: trigger.id,
      deliveryId: delivery.id,
      error: runError,
    });
    errors.push({ triggerId: trigger.id, error: String(runError) });
  }
}
```

If any runs failed to create, the delivery is marked `FAILED` with a summary of errors. Successfully-created runs are still recorded.

#### Step 7 — Delivery Record Update

At the end of the pipeline, update the `GithubWebhookDelivery` record:

```typescript
await prisma.githubWebhookDelivery.update({
  where: { id: delivery.id },
  data: {
    organizationId: org.id,
    processedAt: new Date(),
    status: errors.length > 0 ? 'FAILED' : 'COMPLETED',
    errorMessage: errors.length > 0 ? JSON.stringify(errors) : null,
    // Connect created runs
    runsCreated: {
      connect: createdRunIds.map((id) => ({ id })),
    },
  },
});
```

---

## 5. Prompt Template Rendering

### 5.1 Available Variables

| Variable | Available in | Description |
|---|---|---|
| `{{issue.title}}` | `ISSUES_OPENED`, `ISSUE_COMMENT_CREATED` | Issue title |
| `{{issue.body}}` | `ISSUES_OPENED`, `ISSUE_COMMENT_CREATED` | Issue body (Markdown) |
| `{{issue.number}}` | `ISSUES_OPENED`, `ISSUE_COMMENT_CREATED` | Issue number |
| `{{issue.url}}` | `ISSUES_OPENED`, `ISSUE_COMMENT_CREATED` | GitHub issue URL |
| `{{comment.body}}` | `ISSUE_COMMENT_CREATED` | Comment text |
| `{{comment.author}}` | `ISSUE_COMMENT_CREATED` | Comment author login |
| `{{pr.title}}` | `PULL_REQUEST_REVIEW_SUBMITTED` | PR title |
| `{{pr.body}}` | `PULL_REQUEST_REVIEW_SUBMITTED` | PR description |
| `{{pr.number}}` | `PULL_REQUEST_REVIEW_SUBMITTED` | PR number |
| `{{pr.url}}` | `PULL_REQUEST_REVIEW_SUBMITTED` | GitHub PR URL |
| `{{pr.base_branch}}` | `PULL_REQUEST_REVIEW_SUBMITTED` | PR base branch ref |
| `{{pr.head_branch}}` | `PULL_REQUEST_REVIEW_SUBMITTED` | PR head branch ref |
| `{{review.body}}` | `PULL_REQUEST_REVIEW_SUBMITTED` | Review comment body |
| `{{review.author}}` | `PULL_REQUEST_REVIEW_SUBMITTED` | Reviewer login |
| `{{default_branch}}` | All | Repository's default branch (also used in `runBaseBranch`) |
| `{{repo.full_name}}` | All | `owner/repo` string |

### 5.2 Rendering Logic

```typescript
export function renderPromptTemplate(
  template: string,
  event: ParsedEvent,
): string {
  const vars = buildTemplateVars(event);

  // Replace all {{variable}} occurrences.
  // Variables not available for the current event type are replaced with an empty string.
  return template.replace(/\{\{([^}]+)\}\}/g, (_, key) => {
    return vars[key.trim()] ?? '';
  });
}

function buildTemplateVars(event: ParsedEvent): Record<string, string> {
  const base: Record<string, string> = {
    'default_branch': event.repo?.default_branch ?? '',
    'repo.full_name': event.repo?.full_name ?? '',
  };

  if (event.kind === 'issues_opened') {
    return {
      ...base,
      'issue.title': event.issue.title,
      'issue.body': event.issue.body ?? '',
      'issue.number': String(event.issue.number),
      'issue.url': event.issue.html_url,
    };
  }

  if (event.kind === 'issue_comment_created') {
    return {
      ...base,
      'issue.title': event.issue.title,
      'issue.body': event.issue.body ?? '',
      'issue.number': String(event.issue.number),
      'issue.url': event.issue.html_url,
      'comment.body': event.comment.body,
      'comment.author': event.comment.user.login,
    };
  }

  if (event.kind === 'pull_request_review_submitted') {
    return {
      ...base,
      'pr.title': event.pr.title,
      'pr.body': event.pr.body ?? '',
      'pr.number': String(event.pr.number),
      'pr.url': event.pr.html_url,
      'pr.base_branch': event.pr.base.ref,
      'pr.head_branch': event.pr.head.ref,
      'review.body': event.review.body ?? '',
      'review.author': event.review.user.login,
    };
  }

  return base;
}
```

### 5.3 Template Validation

When a user saves a trigger, validate that the prompt template only references variables available for the chosen event type. Return a user-friendly error for any unknown or mismatched variable. This validation runs in the `createGithubTriggerCommand` and `updateGithubTriggerCommand` handlers.

```typescript
export function validatePromptTemplate(
  template: string,
  eventType: GithubTriggerEventType,
): string[] {
  const allowedVars = ALLOWED_VARS_BY_EVENT[eventType];
  const usedVars = [...template.matchAll(/\{\{([^}]+)\}\}/g)].map((m) => m[1].trim());
  return usedVars.filter((v) => !allowedVars.has(v));
}

const ALLOWED_VARS_BY_EVENT: Record<GithubTriggerEventType, Set<string>> = {
  ISSUES_OPENED: new Set([
    'issue.title', 'issue.body', 'issue.number', 'issue.url',
    'default_branch', 'repo.full_name',
  ]),
  ISSUE_COMMENT_CREATED: new Set([
    'issue.title', 'issue.body', 'issue.number', 'issue.url',
    'comment.body', 'comment.author',
    'default_branch', 'repo.full_name',
  ]),
  PULL_REQUEST_REVIEW_SUBMITTED: new Set([
    'pr.title', 'pr.body', 'pr.number', 'pr.url', 'pr.base_branch', 'pr.head_branch',
    'review.body', 'review.author',
    'default_branch', 'repo.full_name',
  ]),
};
```

---

## 6. UI Flows

### 6.1 Route Structure

```
/orgs/[orgSlug]/projects/[projectSlug]/triggers
  └── +page.svelte                    ← Trigger list
/orgs/[orgSlug]/projects/[projectSlug]/triggers/new
  └── +page.svelte                    ← Create trigger form
/orgs/[orgSlug]/projects/[projectSlug]/triggers/[triggerId]
  └── +page.svelte                    ← Edit trigger form
/orgs/[orgSlug]/settings/webhook
  └── +page.svelte                    ← Org webhook secret configuration
```

### 6.2 Trigger List Page (`/triggers`)

**Layout:**
- Page heading: "GitHub Triggers"
- Sub-heading: "Automatically start agent runs when GitHub events occur on this project."
- "Add trigger" button (top right) → navigates to `/triggers/new`
- Empty state: illustration + "No triggers yet. Add one to start automating your workflow." + CTA button

**Trigger card (per trigger):**
```
┌─────────────────────────────────────────────────────────────┐
│ [●/○ toggle] Auto-fix labelled bugs              [Edit] [⋮] │
│ Issue opened with label "ai-fix"                            │
│ Agent: Claude · Model: claude-sonnet-4-5 · Branch: main    │
│ Created by Alice, 3 days ago                                │
└─────────────────────────────────────────────────────────────┘
```

- Toggle switch calls `toggleGithubTriggerCommand` optimistically; reverts on error.
- "Edit" navigates to `/triggers/[triggerId]`.
- `⋮` menu exposes: "Edit", "Duplicate", "Delete".
- "Delete" shows a confirmation dialog before calling `deleteGithubTriggerCommand`.
- "Duplicate" calls `createGithubTriggerCommand` with the same data + " (copy)" name suffix.

### 6.3 Create/Edit Trigger Form

Single-page form with the following sections:

#### Section 1: Identity
- **Name** (text input, required) — e.g. "Auto-fix labelled bugs"
- **Description** (textarea, optional)
- **Enabled** (toggle, default on)

#### Section 2: Event & Conditions

**Event type** selector (radio or select):
- 🐛 Issue opened
- 💬 Issue comment created
- 🔍 PR review submitted (changes requested)

Conditional fields appear/disappear based on event type selection:

| Selected event | Shown fields |
|---|---|
| Issue opened | Label filter (required) |
| Issue comment | Label filter (required), Comment keyword (optional) |
| PR review submitted | Base branch pattern (optional, placeholder: `main` or `release/*`) |

#### Section 3: Run Template

- **Agent** (select: Claude / Codex)
- **Model** (select, populated based on agent choice)
  - Claude: `claude-opus-4-5`, `claude-sonnet-4-5`, `claude-haiku-4-5`
  - Codex: `codex-latest`, `gpt-4o`
- **Base branch** (text input, default: `{{default_branch}}`)
  - Hint: "Use `{{default_branch}}` to always use the repo's default branch."
- **Prompt template** (textarea, required)
  - Below textarea: collapsible "Available variables" reference list, filtered to variables relevant to the selected event type.
  - Live preview panel: shows the rendered prompt with example values substituted.

#### Section 4: Save

- "Save trigger" / "Update trigger" primary button
- "Cancel" secondary button → navigates back to trigger list
- Inline validation errors on blur and on submit attempt

### 6.4 Org Webhook Configuration (`/settings/webhook`)

**Purpose:** Allow an org admin to set the signing secret that GitHub will use when sending webhook events.

**Layout:**
```
Webhook Secret
──────────────
Configure the signing secret for your organization's GitHub webhook.

Webhook URL (copy):
  https://app.dotweaver.dev/api/github/webhook?orgId=<orgId>

Webhook secret:
  [●●●●●●●●●●●●●●●●] [Rotate secret]  ✓ Configured

Paste this secret into GitHub → Repository Settings → Webhooks → Secret.
```

- If no secret is configured: show a "Generate secret" button that calls `setWebhookSecretCommand` with a newly-generated 32-byte random hex string.
- "Rotate secret" shows a confirmation dialog warning that the old secret will stop working immediately.
- The actual secret value is **never** shown after initial generation (display a masked placeholder). Users must rotate if they lose it.
- **Setup instructions** panel (collapsible):
  1. Copy the Webhook URL above.
  2. In GitHub, go to your repository → Settings → Webhooks → Add webhook.
  3. Paste the URL into "Payload URL".
  4. Set Content type to `application/json`.
  5. Generate a secret here and paste it into GitHub's "Secret" field.
  6. Select events: Issues, Issue comments, Pull request reviews.
  7. Click "Add webhook".

---

## 7. Security Considerations

### 7.1 HMAC Signature Verification

- **Always** verify `X-Hub-Signature-256` before any processing.
- Read the raw request body as bytes; do not parse JSON before verification.
- Use constant-time comparison (`Buffer.compare` equivalent) to avoid timing attacks.
- If the signature header is absent or malformed, respond `400` immediately.
- Log signature failures (without including the secret or body) for monitoring.

### 7.2 Org Scoping via URL Parameter

The webhook URL includes the org ID: `/api/github/webhook?orgId=<orgId>`. This allows:
1. O(1) secret lookup (no brute-force across all orgs).
2. Clear audit trail per org.

The `orgId` query parameter is **untrusted input** — an attacker can forge it. The HMAC verification against that org's secret is what authenticates the request. If the signature check passes with the looked-up org's secret, the org identity is verified. If the org has no secret configured or the signature fails, respond `400`.

### 7.3 Trigger Abuse Prevention

**v1 mitigations:**

- **Project ownership check:** Triggers are only evaluated for the project that owns the GitHub repo ID (`Project.githubRepoId`). A webhook payload from repo A cannot trigger runs on repo B.
- **Org boundary:** Triggers are scoped to the org. A webhook registered under org A cannot fire triggers in org B.
- **Manual approval flow (optional):** If the project has `requiresApproval: true` on runs, triggered runs will enter a `PENDING_APPROVAL` state rather than starting immediately, following the existing approval flow (`approveRunForOrg`).
- **Enabled toggle:** Triggers can be quickly disabled if abuse is detected.

**v2 considerations (not implemented now):**
- Per-trigger rate limiting (e.g. max N runs per hour).
- Cooldown period between trigger fires.
- Allowlist of GitHub users/logins whose events can fire triggers.

### 7.4 Secret Storage

- The `webhookSecret` field in `Organization` must be encrypted at rest using the same encryption mechanism used for GitHub tokens in the existing codebase.
- Never return the secret in any API response (§3.2 `getWebhookSecretStatusQuery` returns only `{ configured: boolean }`).
- Log rotation events in an audit log.

### 7.5 Prompt Injection

GitHub event payloads (issue titles, body, comment text) are user-controlled content that becomes part of the agent's prompt. Mitigations:

- **Structured delimiters:** The prompt template renderer wraps substituted values in XML-style delimiters to prevent content from escaping its intended section:
  ```
  <issue_title>{{issue.title}}</issue_title>
  ```
  Advise users to use this pattern in their templates.
- **Length truncation:** Truncate substituted values to a reasonable maximum (e.g. 8,000 characters for body fields) before inserting into the prompt. Communicate this limit in the UI.
- **No system prompt override:** The trigger's prompt is injected as the user turn, not as a system prompt. The agent's existing system prompt (defined at the project/org level) is not overridable via trigger templates.

### 7.6 Webhook Replay

The `GithubWebhookDelivery.githubDeliveryId` unique constraint prevents replay attacks from duplicate deliveries. GitHub guarantees delivery IDs are unique per delivery attempt; retries of the same event share the same delivery ID.

---

## 8. Error Handling

### 8.1 Signature Verification Failure

- **Response:** `400 Bad Request` with `{ "error": "Invalid signature" }`.
- **Do not** create a `GithubWebhookDelivery` record (no state for invalid requests).
- **Log** at WARN level with: delivery ID (from header, if present), event type, org ID (from query param).

### 8.2 Duplicate Delivery

- **Response:** `200 OK` with `{ "received": true, "deliveryId": "..." }`.
- **Log** at DEBUG level.
- No run creation.

### 8.3 Organization Not Found

- Trigger is a misconfigured webhook (wrong URL or deleted org).
- Mark delivery as `SKIPPED` with reason `"organization_not_found"`.
- **Response:** `200 OK` (do not signal errors to GitHub for org-not-found).
- **Log** at WARN.

### 8.4 Repository Not Matched to a Project

- The webhook's repo ID doesn't match any `Project.githubRepoId` in the org.
- Mark delivery as `SKIPPED` with reason `"no_project_for_repo"`.
- **Response:** `200 OK`.
- **Log** at INFO (this may be normal if the org has many repos).

### 8.5 Parse Error

- The payload doesn't match the expected Zod schema.
- Mark delivery as `FAILED` with the Zod error message.
- **Response:** `200 OK` (GitHub doesn't need to know about our parse errors; it would just retry).
- **Log** at ERROR with payload excerpt for debugging.

### 8.6 Run Creation Error

- `startRunForOrg` throws (e.g. project in error state, infrastructure unavailable).
- Mark delivery as `FAILED` with the error message.
- Do NOT retry automatically in v1 (manual replay via admin tooling).
- **Response:** `200 OK` (already returned before run creation completes — see async consideration below).
- **Log** at ERROR with trigger ID, project ID, delivery ID.

### 8.7 Async Processing Consideration

GitHub expects a `200` response within a few seconds. Run creation (which may involve enqueuing a Docker container) could take longer. In v1, accept the following tradeoff:

- The webhook handler performs run creation synchronously within the request.
- Keep the `startRunForOrg` call lightweight (enqueue only; container start is async via `enqueueRun`).
- If latency becomes a problem in v2, move the handler to a background job queue (e.g. push to a Bull/BullMQ queue and respond `200` immediately).

### 8.8 Delivery History UI

Expose a "Recent deliveries" panel in the org webhook settings page (admin-only):

- Last 50 deliveries, sorted by `receivedAt` descending.
- Show: delivery ID, event type, status badge (RECEIVED / COMPLETED / FAILED / SKIPPED), timestamp.
- For FAILED deliveries: expandable error detail.
- "Replay" button (admin-only): resets the delivery status to `RECEIVED` and re-runs the pipeline (useful for debugging run creation failures).

---

## 9. Testing Strategy

### 9.1 Unit Tests (Vitest)

Location: `src/lib/server/github-triggers/__tests__/`

**`webhook-handler.test.ts`**
- `verifySignature` — correct secret passes, wrong secret fails, absent header fails, constant-time behavior
- `matchTrigger` — all event types, all condition combinations, disabled triggers excluded
- `renderPromptTemplate` — all variables, missing variables become empty string, unknown variables become empty string
- `validatePromptTemplate` — valid templates pass, invalid variable names return error list

**`service.test.ts`**
- CRUD operations on `GithubTrigger`
- Idempotency: duplicate delivery ID is rejected with duplicate result
- `setWebhookSecret` encrypts the value

### 9.2 Integration Tests (Vitest + test DB)

**`webhook-integration.test.ts`**
- Full pipeline with a real Prisma client against a test database
- `issues.opened` event → matching trigger → run created and linked to delivery
- `issue_comment.created` with keyword filter — matching and non-matching comment
- `pull_request_review.submitted` with base branch pattern — glob matching
- Duplicate delivery — second call returns `duplicate`, no second run created
- Invalid signature — returns early, no delivery record created

### 9.3 E2E Tests (Playwright)

Location: `tests/e2e/github-triggers/`

**`trigger-management.spec.ts`**
- Create a trigger via the UI form, verify it appears in the list
- Edit a trigger — changes are persisted
- Enable/disable toggle — optimistic update, server confirm
- Delete trigger — confirmation dialog, removal from list

**`webhook-settings.spec.ts`**
- Generate webhook secret — masked display, URL shown
- Rotate secret — confirmation dialog, new secret configured

---

## 10. Out of Scope / Future Work

### v1 Explicitly Out of Scope

| Feature | Reason |
|---|---|
| `push` events | High volume; need branch filtering and deduplication first |
| PR `opened` / `merged` events | Common use case but adds complexity; defer to v2 |
| Cron / scheduled triggers | Different architecture (requires a scheduler process) |
| Multi-trigger deduplication | E.g. two triggers fire for same issue — v2 with run grouping |
| Per-trigger rate limiting | Requires a rate limit store; defer to v2 |
| Trigger analytics / run history | Nice to have; existing Run list is sufficient for now |
| GitHub App installation flow | Currently using per-repo tokens; full App OAuth is a larger project |
| Webhook event replay from admin UI | Delivery records are stored; replay button is a v1.5 nice-to-have |

### v2 Candidates

- **Rate limiting:** Token bucket per trigger (e.g. max 10 runs/hour). Store in Redis or PostgreSQL.
- **Deduplication:** If trigger A and trigger B both match the same event, create one run with a merged prompt, or configure a "one run per event" setting at the project level.
- **PR opened/merged events:** Add `PULL_REQUEST_OPENED` and `PULL_REQUEST_MERGED` event types with corresponding conditions.
- **Allowlist by GitHub actor:** Only fire a trigger if the event was initiated by a user in a given allowlist (e.g. only org members can `/ai-fix` via comment).
- **Trigger conditions: status checks:** Only fire if the repo's CI status is passing/failing.
- **Observability:** Metrics on trigger fire rate, run success rate, prompt rendering latency. Export to existing monitoring.
- **Org-level trigger templates:** Shared trigger templates that individual projects inherit and can override.
- **GitHub App:** Move from per-repo PATs to a proper GitHub App installation for more robust webhook registration and token management.

---

## Appendix A — Service Interface

```typescript
// src/lib/server/github-triggers/service.ts

export interface GithubTriggersService {
  // CRUD
  listForProject(projectId: string): Promise<GithubTrigger[]>;
  getById(triggerId: string): Promise<GithubTrigger>;
  create(input: CreateGithubTriggerInput, createdById: string): Promise<GithubTrigger>;
  update(input: UpdateGithubTriggerInput): Promise<GithubTrigger>;
  delete(triggerId: string): Promise<void>;
  setEnabled(triggerId: string, enabled: boolean): Promise<GithubTrigger>;

  // Webhook secret management
  setWebhookSecret(organizationId: string, secret: string): Promise<void>;
  getWebhookSecret(organizationId: string): Promise<string | null>;
  hasWebhookSecret(organizationId: string): Promise<boolean>;
}
```

## Appendix B — Webhook Handler Interface

```typescript
// src/lib/server/github-triggers/webhook-handler.ts

export interface WebhookHandlerService {
  handle(input: WebhookHandleInput): Promise<WebhookHandleResult>;
}
```

## Appendix C — GitHub Webhook Registration Checklist

When a user sets up the webhook on GitHub, they must configure:

| Setting | Value |
|---|---|
| Payload URL | `https://<your-domain>/api/github/webhook?orgId=<orgId>` |
| Content type | `application/json` |
| Secret | The secret generated in dotWeaver's Webhook Settings page |
| SSL verification | Enabled |
| Events | Select individual events: **Issues**, **Issue comments**, **Pull request reviews** |
| Active | ✓ |

> **Note for implementers:** Consider adding a "Verify connection" button in the dotWeaver webhook settings UI that sends a ping request to GitHub (`POST /repos/{owner}/{repo}/hooks/{hook_id}/pings`) and confirms the webhook is reachable and correctly configured.

---

*End of specification — GitHub Triggers v1*
