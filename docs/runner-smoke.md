# Smoke test du runner (DOT-16 Phase 2A)

Vérifie de bout en bout : workspace → conteneur → agent → commit. Manuel (nécessite
Docker démarré et un `CLAUDE_CODE_OAUTH_TOKEN` valide).

## 1. Prérequis

- Construire l'image : `docker build -t dotweaver-runner docker/runner`
- `export CLAUDE_CODE_OAUTH_TOKEN=...` (via `claude setup-token`).
- S'assurer qu'aucun `ANTHROPIC_API_KEY` n'est exporté (sinon il écrase l'abonnement ;
  l'entrypoint le supprime côté conteneur, mais vérifier l'intention).

## 2. Préparer un workspace de test

> **Colima/Mac** : le dossier monté DOIT être sous `$HOME` — Colima ne partage pas `/tmp`
> (ni les chemins `mktemp` macOS) avec sa VM, donc un mount hors `$HOME` apparaît **vide**
> dans le conteneur. On utilise donc `$HOME/dw-smoke-...` plutôt que `mktemp -d`.

```bash
TMP="$HOME/dw-smoke-$$"; mkdir -p "$TMP"
git init -b main "$TMP/src" && (cd "$TMP/src" && \
  git config user.email t@t.t && git config user.name t && \
  echo "# demo" > README.md && git add -A && git commit -m init)
git clone --mirror "$TMP/src" "$TMP/repo.git"
git clone --no-checkout "$TMP/repo.git" "$TMP/wt"
(cd "$TMP/wt" && git checkout -b claude/smoke main)
```

## 3. Lancer l'agent

```bash
docker run --rm \
  --cap-drop ALL --security-opt no-new-privileges \
  --memory 4g --cpus 2 --pids-limit 512 \
  -v "$TMP/wt:/workspace" -w /workspace \
  -e RUN_PROMPT="Create a file HELLO.md containing the word 'hi', then stop." \
  -e CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN" \
  dotweaver-runner
```

## 4. Attendu

- stdout : des lignes JSON (messages SDK : `system`/init avec `session_id`, `assistant`,
  `result`), puis une ligne finale `runner_summary` avec `head` + `session_id`.
- Le commit est dans le **checkout** (bind-monté), pas dans le miroir :
  `git -C "$TMP/wt" log --oneline claude/smoke` montre un nouveau commit au-dessus de `init`,
  et `HELLO.md` existe (`ls "$TMP/wt/HELLO.md"`).

## 5. Nettoyage

```bash
rm -rf "$TMP"
```

## Notes

- **Conteneur en root (MVP)** : le checkout bind-monté appartient à l'uid de l'hôte. Un user
  non-root dans le conteneur ne passerait pas le contrôle « dubious ownership » de git et ne
  pourrait pas écrire dans `.git`. On tourne donc en **root** + `git config --global --add
  safe.directory /workspace` (dans l'entrypoint). La frontière reste le conteneur (`--cap-drop
  ALL`, `--security-opt no-new-privileges`, limites). Non-root + alignement d'uid = durcissement
  Phase 5 (hôte Linux).
- **Mount Colima** : `WORKSPACE_ROOT` (et tout dossier monté) doit être sous `$HOME` sur Colima.
- **Dette sécurité MVP** : réseau ouvert (`--network bridge` par défaut côté orchestrateur) et
  rootfs non read-only. L'egress Anthropic-only + rootfs ro sont prévus en Phase 5.
