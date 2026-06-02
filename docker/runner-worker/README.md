# Runner worker — déploiement

Worker long-running qui consomme la file pg-boss (`run-execute`) et lance les
conteneurs **agents** (image `dotweaver-runner`, construite depuis `docker/runner/`)
via le démon Docker de l'hôte.

## Pré-requis runtime (Docker-out-of-Docker)

Le runner shell-out vers la CLI `docker` et **bind-monte un chemin de l'hôte** dans
le conteneur agent (`-v <checkout>:/workspace`). Ce bind est résolu par le démon de
l'hôte, pas dans le conteneur runner. Deux montages sont donc obligatoires :

| Montage hôte → conteneur | Rôle |
|---|---|
| `/var/run/docker.sock` → `/var/run/docker.sock` | piloter le démon de l'hôte |
| `/data/dotweaver/workspaces` → `/data/dotweaver/workspaces` *(chemins identiques)* | checkouts partagés runner ↔ agents |

> Les deux chemins du workspace **doivent être identiques** : sinon l'agent voit un
> `/workspace` vide.

## Variables d'environnement

| Variable | Valeur | Note |
|---|---|---|
| `DATABASE_URL` | même Postgres que le front | file pg-boss + Prisma |
| `WORKSPACE_ROOT` | `/data/dotweaver/workspaces` | = chemin du bind mount |
| `RUNNER_IMAGE` | `dotweaver-runner` | image agent |
| `CLAUDE_CODE_OAUTH_TOKEN` | token abonnement | injecté dans chaque agent |
| `RUN_TIMEOUT_MS` | `1800000` (optionnel) | défaut 30 min |

L'image agent est auto-construite au premier run (`ensureImage`). Après toute
modification de `docker/runner/Dockerfile`, forcer : `bun run runner:build-image`.

## Sécurité

Monter `docker.sock` = accès root à l'hôte. Les agents sont durcis
(`--cap-drop ALL`, `no-new-privileges`, limites cpu/ram/pids) mais le worker ne l'est
pas. Durcissement (rootless, allowlist egress, rootfs read-only) = Phase 5.
