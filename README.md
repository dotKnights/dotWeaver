# dotWeaver

dotWeaver is a team-oriented control plane for running coding agents against GitHub repositories.
It lets users connect GitHub, import repositories, configure per-project agent context, launch
Claude Code or Codex runs in isolated Docker workspaces, review the generated diff, and push the
result back as a branch or pull request.

The project is built as a SvelteKit application with a PostgreSQL-backed job queue and a separate
runner process that executes agent containers.

## Purpose

The goal of dotWeaver is to make agentic coding work operational rather than ad hoc. Instead of
running an agent in a local terminal and manually keeping track of branches, prompts, secrets,
MCP servers, and follow-up questions, dotWeaver stores that workflow in one place:

- teams own projects, secrets, environment variables, skills, MCP servers, and run history;
- agents work from a clean checkout and write changes to an isolated branch;
- the UI streams agent events, pending questions, todos, diffs, and review actions;
- completed work can be abandoned, pushed as a branch, or opened as a pull request;
- the same project/run operations are exposed to external MCP clients.

In short: dotWeaver is meant to be the collaboration layer between teams, repositories, and coding
agents.

## Product Goals

- Provide a repeatable way to run coding agents against real repositories.
- Keep GitHub import, branch selection, run prompts, model choice, and review state visible.
- Support both Claude Code and Codex as runnable agents.
- Let projects define reusable agent configuration: MCP servers, skills, secrets, and environment
  variables.
- Preserve a durable event timeline for every run, including tool output, assistant messages,
  user replies, and review status.
- Make agent runs interactive: an agent can ask the user a question, wait, then resume.
- Expose dotWeaver through a remote MCP endpoint so clients like Claude Desktop, Claude.ai, or MCP
  Inspector can list projects, start runs, stream progress, and approve results.
- Keep team and project boundaries explicit so one organization cannot read or mutate another
  organization's runs.

## Current Capabilities

- Email/password auth plus GitHub and Google OAuth via Better Auth.
- Team creation, membership, invitations, and active-team selection.
- GitHub repository listing and project import.
- Project detail pages with branch selection and agent-run launch controls.
- Claude Code and Codex run support, with selectable agent/model.
- Project agent configuration:
  - HTTP, SSE, and stdio MCP server declarations;
  - imported or manually authored skills;
  - named secrets;
  - environment variables;
  - `.mcp.json`, `SKILL.md`, and dotenv import helpers.
- Docker-based runner execution with per-run worktrees.
- Live run event streaming over Server-Sent Events.
- Interactive run replies and structured `AskUserQuestion` handling.
- Diff review, branch push, and pull request creation.
- Gmail read-only connector and local thread index for the mail page.
- Remote MCP server at `/mcp` with OAuth-protected tools for teams, projects, runs, diffs, and run
  lifecycle actions.

## Main Workflow

1. Sign in or register.
2. Create or select a team.
3. Connect GitHub.
4. Import a repository as a dotWeaver project.
5. Configure optional project agent context: MCP servers, skills, secrets, and env vars.
6. Start a run with a prompt, base branch, agent, and optional model.
7. Watch the event stream and answer the agent if it asks for input.
8. Review the generated diff.
9. Abandon the run, push the branch, or open a pull request.

## Architecture

```text
SvelteKit web app
  routes, auth, project UI, run UI, MCP endpoint

PostgreSQL
  Better Auth data, teams, projects, run events, queue jobs, mail index

pg-boss
  run-execute queue

Runner process
  consumes queued runs and orchestrates Git workspaces + Docker containers

Agent container
  runs Claude Code or Codex inside /workspace
```

Key pieces:

- `src/routes/(app)` - authenticated web application routes.
- `src/routes/(auth)` - login and registration routes.
- `src/routes/mcp/+server.ts` - remote MCP endpoint.
- `src/lib/server/auth.ts` - Better Auth setup.
- `src/lib/server/queue.ts` - pg-boss queue setup.
- `src/lib/server/run-orchestrator.ts` - end-to-end run execution.
- `src/lib/server/project-agent-config-service.ts` - materializes project MCP/skill/env config.
- `src/runner/index.ts` - long-running worker that consumes run jobs.
- `docker/runner` - image used to execute Claude Code or Codex runs.
- `prisma/schema.prisma` - PostgreSQL data model.

## Tech Stack

- TypeScript
- SvelteKit 5
- Tailwind CSS 4
- Prisma 7
- PostgreSQL
- pg-boss
- Better Auth
- MCP SDK and `mcp-handler`
- Docker
- Bun
- Vitest and Playwright

## Local Development

Install dependencies:

```bash
bun install
```

Create a local env file from the example:

```bash
cp .env.example .env
```

At minimum, set:

```bash
DATABASE_URL="postgres://user:password@localhost:5432/dbname"
BETTER_AUTH_SECRET="generate-a-32-byte-secret"
BETTER_AUTH_URL="http://localhost:5173"
```

For GitHub login and repository access, create a GitHub OAuth App:

```text
Homepage URL: http://localhost:5173
Authorization callback URL: http://localhost:5173/api/auth/callback/github
```

Then set:

```bash
GITHUB_CLIENT_ID="..."
GITHUB_CLIENT_SECRET="..."
```

For Google/Gmail, configure a Google OAuth web client with:

```text
Authorized JavaScript origin: http://localhost:5173
Authorized redirect URI: http://localhost:5173/api/auth/callback/google
```

The app requests read-only Gmail access:

```text
https://www.googleapis.com/auth/gmail.readonly
```

Apply database migrations and generate Prisma client:

```bash
bunx prisma migrate deploy
bunx prisma generate
```

Start the web app:

```bash
bun run dev -- --host 0.0.0.0
```

Open:

```text
http://localhost:5173/login
```

## Runner

Build the agent container:

```bash
bun run runner:build-image
```

Start the worker:

```bash
bun run runner
```

Runner-related env vars:

- `WORKSPACE_ROOT` - host path where mirrors and per-run worktrees are stored.
- `RUNNER_IMAGE` - Docker image used for agent containers, defaults to `dotweaver-runner`.
- `RUNNER_NETWORK` - Docker network shared by agent, prepare, and persistent service
  containers. Defaults to the user-defined network `dotweaver-runner`; use `coolify` or another
  external network in production if needed.
- `PROJECT_ENVIRONMENT_PREPARE_TIMEOUT_MS` - optional dependency prepare timeout in milliseconds,
  defaulting to `600000` (10 minutes).
- `CLAUDE_CODE_OAUTH_TOKEN` - Claude Code subscription token.
- `CODEX_API_KEY` or `CODEX_ACCESS_TOKEN` - Codex auth.
- `CODEX_AUTH_JSON_PATH` - optional path to a local Codex auth cache.
- `RUN_TIMEOUT_MS` - optional per-run timeout override.

On macOS/Colima, keep `WORKSPACE_ROOT` under `$HOME` so Docker can bind-mount it.

Service env mappings can be edited from a project's setup page. To verify a custom Postgres
mapping, add `DIRECT_URL=${url}` on the Postgres service, provision the service, then launch a new
run and ask the agent to check that `process.env.DIRECT_URL` exists without printing its value.

## MCP

dotWeaver exposes a remote MCP server:

```text
http://localhost:5173/mcp
```

It uses OAuth through Better Auth and supports tools for:

- listing teams;
- listing and importing projects;
- starting, reading, canceling, and replying to runs;
- reading diffs;
- approving runs as PRs;
- streaming run events.

See [docs/mcp.md](docs/mcp.md) for the full protocol and tool reference.

## Useful Commands

```bash
bun run dev
bun run check
bun run lint
bun run test:unit -- --run
bun run test:e2e
bun run build
bun run runner
bun run runner:build-image
```

## Documentation

- [Remote MCP reference](docs/mcp.md)
- [Runner smoke test](docs/runner-smoke.md)
- `docs/superpowers/specs` - feature design documents
- `docs/superpowers/plans` - implementation plans and historical build notes

## Security Notes

- Do not commit `.env` or real credentials.
- Keep `.env.example` as placeholders only.
- GitHub OAuth needs the classic OAuth App client ID/secret pair for the current code path.
- Agent runs execute in Docker containers with reduced capabilities, but the runner still controls
  Docker on the host; treat it as privileged operational infrastructure.
- Project secrets and sensitive env vars are stored encrypted before being materialized into a run
  workspace.

## Status

dotWeaver is an active MVP. The core web app, runner pipeline, project configuration model, and MCP
surface exist, but deployment hardening, production operations, and provider setup still need careful
environment-specific configuration.
