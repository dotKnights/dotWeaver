FROM node:22-slim

# git pour l'outil Bash de l'agent ; ca-certificates pour le TLS vers l'API modèle.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends git ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /runner
COPY package.json ./
RUN npm install --omit=dev

COPY entrypoint.mjs ./

# MVP : on tourne en root dans le conteneur. Le workspace est bind-monté depuis l'hôte
# (uid hôte ≠ uid conteneur) ; un utilisateur non-root ne pourrait ni passer le contrôle
# « dubious ownership » de git ni écrire dans `.git`. La frontière de sécurité reste le
# conteneur (`--cap-drop ALL`, `--security-opt no-new-privileges`, limites). Le passage
# non-root + alignement d'uid sur l'hôte Linux est une tâche de durcissement (Phase 5).
WORKDIR /workspace
ENTRYPOINT ["node", "/runner/entrypoint.mjs"]
