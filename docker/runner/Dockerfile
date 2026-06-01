FROM node:22-slim

# git + curl pour l'outil Bash de l'agent ; ca-certificates pour le TLS vers l'API modèle.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends git curl ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /runner
COPY package.json ./
RUN npm install --omit=dev

# Le binaire arm64 embarqué par l'Agent SDK 0.3.x est cassé (pré-parseur Bun qui
# intercepte les args de lancement). On installe la vraie CLI Claude Code et on pointe
# le SDK dessus via `pathToClaudeCodeExecutable` dans l'entrypoint.
RUN npm install -g @anthropic-ai/claude-code

COPY entrypoint.mjs ./

# MVP : on tourne en root dans le conteneur. Le workspace est bind-monté depuis l'hôte
# (uid hôte ≠ uid conteneur) ; un utilisateur non-root ne pourrait ni passer le contrôle
# « dubious ownership » de git ni écrire dans `.git`. La frontière de sécurité reste le
# conteneur (`--cap-drop ALL`, `--security-opt no-new-privileges`, limites). Le passage
# non-root + alignement d'uid sur l'hôte Linux est une tâche de durcissement (Phase 5).
WORKDIR /workspace
ENTRYPOINT ["node", "/runner/entrypoint.mjs"]
