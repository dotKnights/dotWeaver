# Image du WORKER runner (≠ image agent dans docker/runner/).
# Ce conteneur consomme la file pg-boss et pilote le démon Docker de l'hôte
# (Docker-out-of-Docker) pour lancer les conteneurs agents. Il a donc besoin :
#   - de la CLI `docker` (le socket de l'hôte est monté au runtime),
#   - de `git` (clone mirror + checkout des projets),
#   - du code de l'app + node_modules (dev inclus, pour vite-node) + client Prisma.
#
# ⚠️ WORKSPACE_ROOT doit pointer vers un chemin bind-monté depuis l'hôte au MÊME
# chemin absolu (sinon le bind `-v <checkout>:/workspace` de l'agent, résolu par le
# démon de l'hôte, ne trouve rien). Voir docker/runner-worker/README.md.

FROM docker:27-cli AS docker-cli

FROM node:22-bookworm-slim

# CLI docker (binaire seul — le démon est celui de l'hôte via le socket monté).
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker

RUN apt-get update \
	&& apt-get install -y --no-install-recommends git ca-certificates curl unzip \
	&& rm -rf /var/lib/apt/lists/*

# bun (gestionnaire de paquets du projet + lanceur du script `runner`).
RUN curl -fsSL https://bun.sh/install | bash \
	&& ln -s /root/.bun/bin/bun /usr/local/bin/bun \
	&& ln -s /root/.bun/bin/bunx /usr/local/bin/bunx

WORKDIR /app
COPY . .

# Deps complètes (vite-node est un devDependency) + génération du client Prisma.
RUN bun install --frozen-lockfile \
	&& bunx prisma generate

# Worker long-running : consomme la file et ne sort pas (sauf erreur fatale).
CMD ["bun", "run", "runner"]
