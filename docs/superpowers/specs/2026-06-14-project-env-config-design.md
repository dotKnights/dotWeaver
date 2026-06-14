# Configuration des variables `.env` par projet -- Design

**Date** : 2026-06-14
**Statut** : Valide en brainstorming, en attente de relecture
**Perimetre** : v1 -- variables `.env` chiffrees, fusionnees dans le checkout au run

## Objectif

Permettre a un utilisateur dotWeaver de definir des variables d'environnement
par projet, stockees chiffrees, et de les materialiser dans un fichier `.env` a
la racine du checkout au lancement d'un run. Les tests, builds et dev servers du
depot peuvent ainsi lire la configuration attendue, sans que ces variables ne
soient jamais commitees ni poussees.

Le concept s'inscrit dans la config agent projet existante (MCP / Skills /
Secrets), reutilise le chiffrement et le mecanisme de protection git deja en
place, et suit les memes patterns de CRUD, remote functions et UI.

## Decisions de cadrage (issues du brainstorming)

- **Cible d'injection** : un fichier `.env` ecrit a la racine du checkout (pas
  des variables d'environnement du conteneur).
- **Modele** : un nouveau modele `ProjectEnvVar` distinct des `ProjectSecret`
  (qui restent dedies aux references MCP).
- **Collision `.env`** : fusion. On lit le `.env` existant et on surcharge /
  ajoute uniquement les cles gerees, en conservant le reste.
- **Perimetre v1** : CRUD cle/valeur, import `.env` colle, toggle `enabled` par
  variable, masquage des valeurs (chiffrees au repos).

## Modele de donnees (Prisma)

```prisma
model ProjectEnvVar {
  id             String   @id @default(cuid())
  projectId      String
  project        Project  @relation(fields: [projectId, organizationId], references: [id, organizationId], onDelete: Cascade)
  organizationId String
  key            String
  valueEncrypted String
  sensitive      Boolean  @default(true)
  enabled        Boolean  @default(true)
  createdById    String
  createdBy      User     @relation(fields: [createdById], references: [id], onDelete: Cascade)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @default(now()) @updatedAt

  @@unique([projectId, key])
  @@index([organizationId, projectId])
  @@map("project_env_var")
}
```

- Relations ajoutees : `envVars ProjectEnvVar[]` sur `Project` et sur `User`.
- Chiffrement : reutilisation de `encryptProjectSecretValue` /
  `decryptProjectSecretValue` (AES-256-GCM, cle `PROJECT_SECRET_ENCRYPTION_KEY`).
- Migration Prisma dediee (creation de table + index + contrainte unique).

## Schemas (`src/lib/schemas/project-agent-config.ts`)

- `envVarKeySchema` : `/^[A-Za-z_][A-Za-z0-9_]*$/`, longueur 1..128 (nom de
  variable POSIX valide).
- `projectEnvVarInputSchema` :
  `{ projectId, key: envVarKeySchema, value: z.string().min(1), sensitive?: boolean }`.
  La sensibilite par defaut est devinee via `isSensitiveConfigKey(key)` (helper
  existant) quand `sensitive` n'est pas fourni.
- `setProjectEnvVarSensitiveSchema` : `projectConfigIdSchema.extend({ sensitive })`.
- Toggle `enabled` : reutilise `projectConfigEnabledSchema` existant.
- `importProjectEnvFileSchema` : `{ projectId, content: z.string().min(1) }`
  (upsert par cle, non destructif).

## Parsing `.env` -- module isole `src/lib/server/dotenv.ts`

Unite autonome et testable independamment.

- `parseDotenv(text): { key, value }[]` : ignore les lignes vides et les
  commentaires (`#` en debut de ligne), gere le prefixe `export `, retire les
  quotes simples/doubles entourantes. Les cles invalides sont rejetees ou
  ignorees avec un compte rendu (voir import).
- `mergeDotenv(existingText, managed: { key, value }[]): string` : conserve le
  texte existant (commentaires et cles non gerees), remplace en place les lignes
  des cles gerees presentes, ajoute les cles manquantes sous un bloc
  `# dotWeaver managed`. Implemente la semantique de fusion.

## Service (`src/lib/server/project-agent-config-service.ts`)

- Projection `listProjectAgentConfigForOrg` : ajoute
  `envVars: { id, key, enabled, sensitive, value }[]`. `value` n'est renvoyee en
  clair que si `sensitive === false` ; sinon `null`.
- CRUD pour l'org :
  - `upsertProjectEnvVarForOrg` (chiffre la valeur, devine `sensitive`),
  - `deleteProjectEnvVarForOrg`,
  - `setProjectEnvVarEnabledForOrg`,
  - `setProjectEnvVarSensitiveForOrg`,
  - `revealProjectEnvVarForOrg` (dechiffre et renvoie la valeur d'une variable),
  - `importProjectEnvFileForOrg` (parse + upsert par cle, renvoie le nombre
    importe et les cles ignorees).
- `RuntimeAgentConfig` : nouveau champ `envFile: { key, value }[]`.
  `snapshot.envVars: { key }[]` -- **jamais de valeurs dans le snapshot**.
- `buildRunAgentConfig` : charge les `ProjectEnvVar` `enabled`, dechiffre,
  remplit `envFile` et `snapshot.envVars`.
- `materializeRunAgentConfig` : lit le `.env` existant du checkout (s'il
  existe), applique `mergeDotenv`, ecrit le fichier, puis ajoute `.env` a
  `generatedPaths` afin qu'il beneficie du git exclude + `skip-worktree` deja
  en place.

## Remote functions (`src/lib/rfc/project-agent-config.remote.ts`)

Miroir du CRUD secrets, chacune rafraichit `getProjectAgentConfig` :
`upsertProjectEnvVar`, `deleteProjectEnvVar`, `setProjectEnvVarEnabled`,
`setProjectEnvVarSensitive`, `revealProjectEnvVar`, `importProjectEnvFile`.

## UI

- `AgentConfigPanel.svelte` : nouvelle section « Environment (.env) » listant
  chaque variable -- cle, valeur masquee (`••••` + bouton reveler pour les
  sensibles ; affichage inline si non sensible), toggle `enabled`, toggle
  `sensitive`, suppression.
- Nouveau `EnvVarEditor.svelte` (calque sur `SecretEditor.svelte`) : champs cle
  + valeur + case « sensible ».
- Zone de collage « Importer un .env » (calquee sur l'import JSON MCP).

## Securite

- Valeurs chiffrees au repos. Les valeurs sensibles ne quittent jamais le
  serveur sans action explicite (`revealProjectEnvVar`).
- Le `.env` fusionne est ajoute au git exclude et marque `skip-worktree` : il
  n'est jamais stage, commite, pousse, ni present dans le diff du run. C'est la
  protection centrale contre la fuite de secrets via la PR. Le mecanisme couvre
  les trois cas : `.env` tracke, ignore, ou simplement non suivi.
- Cles validees comme noms de variables POSIX (`envVarKeySchema`).

## Tests (miroir de l'existant)

- `tests/unit/lib/server/dotenv.test.ts` : `parseDotenv` (quotes, export,
  commentaires, cles invalides) et `mergeDotenv` (remplacement en place, ajout,
  preservation des lignes non gerees).
- `tests/unit/lib/schemas/project-agent-config.test.ts` : `envVarKeySchema`,
  `projectEnvVarInputSchema`, `importProjectEnvFileSchema`.
- `tests/unit/lib/server/project-agent-config-service.test.ts` : CRUD, masquage
  dans la projection, `buildRunAgentConfig.envFile`, `materializeRunAgentConfig`
  (fusion + protection git), `revealProjectEnvVarForOrg`.
- `tests/unit/lib/rfc/project-agent-config.remote.test.ts` : nouvelles commandes.
- `tests/unit/lib/server/run-orchestrator.test.ts` : un cas verifiant l'ecriture
  du `.env` quand `useProjectAgentConfig` est actif.

## Hors perimetre (YAGNI v1)

- Valeurs vides (`FOO=`) : `value` requiert `min(1)` ; les lignes a valeur vide
  a l'import sont ignorees et reportees.
- Chemin / nom de fichier configurable : toujours `.env` a la racine.
- Remplacement destructif en masse a l'import.
- Fichiers multi-env (`.env.local`, `.env.production`, ...).
- Referencement de `ProjectSecret` depuis une variable `.env`.
