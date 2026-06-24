FROM node:22-slim

ARG PNPM_VERSION=11.9.0
ARG UV_VERSION=0.11.24
ARG POETRY_VERSION=2.4.1
ARG BUN_VERSION=1.3.14

# git + curl pour l'outil Bash de l'agent ; ca-certificates pour le TLS vers l'API modèle.
# ripgrep accélère les recherches faites par les agents. Les runtimes/managers
# ci-dessous permettent aux prepares de projets Node, Bun et Python de tourner
# dans la même image runner durable.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		git \
		curl \
		ca-certificates \
		ripgrep \
		python3 \
		python3-pip \
		python3-venv \
		unzip \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /runner
COPY package.json ./
RUN npm install --omit=dev

# Le binaire arm64 embarqué par l'Agent SDK 0.3.x est cassé (pré-parseur Bun qui
# intercepte les args de lancement). On installe la vraie CLI Claude Code et on pointe
# le SDK dessus via `pathToClaudeCodeExecutable` dans l'entrypoint.
RUN npm install -g @anthropic-ai/claude-code
RUN npm install -g @openai/codex
RUN yarn --version \
	&& npm install -g "pnpm@${PNPM_VERSION}" \
	&& python3 -m pip install --no-cache-dir --break-system-packages \
		"uv==${UV_VERSION}" \
		"poetry==${POETRY_VERSION}"

ENV BUN_INSTALL=/usr/local/bun
ENV PATH="${BUN_INSTALL}/bin:${PATH}"
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"

COPY entrypoint.mjs ask-user-question-tool.mjs dotweaver-mcp-server.mjs ./

# MVP : on tourne en root dans le conteneur. Le workspace est bind-monté depuis l'hôte
# (uid hôte ≠ uid conteneur) ; un utilisateur non-root ne pourrait ni passer le contrôle
# « dubious ownership » de git ni écrire dans `.git`. La frontière de sécurité reste le
# conteneur (`--cap-drop ALL`, `--security-opt no-new-privileges`, limites). Le passage
# non-root + alignement d'uid sur l'hôte Linux est une tâche de durcissement (Phase 5).
WORKDIR /workspace
ENTRYPOINT ["node", "/runner/entrypoint.mjs"]
