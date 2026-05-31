FROM node:22-slim

# git pour l'outil Bash de l'agent ; ca-certificates pour le TLS vers l'API modèle.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends git ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /runner
COPY package.json ./
RUN npm install --omit=dev

COPY entrypoint.mjs ./

# Utilisateur non-root ; /workspace est bind-monté au runtime.
RUN useradd --create-home --uid 1001 agent \
	&& mkdir -p /workspace && chown agent:agent /workspace
USER agent

WORKDIR /workspace
ENTRYPOINT ["node", "/runner/entrypoint.mjs"]
