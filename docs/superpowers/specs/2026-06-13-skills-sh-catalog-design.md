# Catalogue skills.sh pour la config agent projet -- Design

**Date** : 2026-06-13
**Statut** : Valide en brainstorming, en attente de relecture
**Perimetre** : v1 catalogue natif + import de snapshots skills.sh

## Objectif

Permettre a un utilisateur dotWeaver d'ajouter rapidement des skills publics
depuis skills.sh dans la config agent d'un projet, sans modifier le depot Git du
projet. L'utilisateur cherche un skill, consulte un apercu, clique "Add to
project", puis le skill devient disponible pour les prochains runs Claude Code
via le flux existant de materialisation `.claude/skills/<skill>/...`.

## References observees

- skills.sh expose un catalogue public de skills et un leaderboard.
- Le CLI `npx skills` installe pour Claude Code dans `.claude/skills/`.
- `npx skills add` ecrit un `skills-lock.json` contenant notamment `source`,
  `skillPath` et `computedHash`.
- Le package `skills@1.5.11` utilise `https://skills.sh/api/search` pour la
  recherche et `https://skills.sh/api/download/<owner>/<repo>/<skill>` pour
  telecharger un snapshot.

Ces references guident le design, mais dotWeaver n'executera pas `npx skills`
dans les depots utilisateurs en v1. dotWeaver importe les snapshots cote serveur
et les stocke dans sa propre config projet.

## Decisions de cadrage

| Sujet | Decision |
|---|---|
| Produit | Catalogue natif dans `Agent config > Skills` |
| Source v1 | skills.sh uniquement |
| Installation | Import serveur du snapshot, stockage DB projet |
| Runtime | Materialisation dans le checkout du run |
| Depot Git projet | Aucune ecriture au moment de l'import |
| Contenu supporte | `SKILL.md` + fichiers annexes |
| Provenance | Source, skill id, URL, hash, date d'import |
| Updates | Re-import manuel en v1, pas d'auto-update |
| Securite | Pas d'execution de scripts a l'import |

## Flux utilisateur

1. L'utilisateur ouvre un projet puis `Agent config > Skills`.
2. Il clique `Browse skills.sh`.
3. Une recherche serveur interroge skills.sh a partir de deux caracteres.
4. Les resultats affichent au minimum :
   - nom du skill ;
   - package source, par exemple `anthropics/skills` ;
   - installs si fourni par skills.sh ;
   - lien externe vers skills.sh.
5. L'utilisateur ouvre un resultat en preview.
6. dotWeaver telecharge le snapshot et affiche :
   - frontmatter et extrait du `SKILL.md` ;
   - source package ;
   - hash du snapshot ;
   - liste des fichiers annexes ;
   - avertissement indiquant que les skills sont des instructions tierces.
7. L'utilisateur clique `Add to project`.
8. Si un skill du meme nom existe deja dans le projet, l'UI demande une
   confirmation de remplacement.
9. Le skill est stocke en DB, active par defaut et apparait dans la liste des
   skills projet.
10. Au prochain run avec `Use project agent config`, dotWeaver ecrit le skill
    dans `.claude/skills/<name>/...`.

## Architecture

```
AgentConfigPanel.svelte
  └─ SkillsShCatalog.svelte
       ├─ searchSkillsSh(query)
       ├─ getSkillsShSkill(source, skill)
       └─ importSkillsShSkill(projectId, source, skill, replace?)

Remote functions
  └─ src/lib/server/skills-sh-service.ts
       ├─ searchSkills(query)
       ├─ downloadSkill(source, skill)
       ├─ normalizeSkillSnapshot(snapshot)
       └─ validateSkillFiles(files)

Project agent config service
  ├─ upsertImportedProjectSkillForOrg(...)
  ├─ buildRunAgentConfig(...)
  └─ materializeRunAgentConfig(...)

Run checkout
  └─ .claude/skills/<skill-name>/
       ├─ SKILL.md
       └─ supporting files
```

Le service skills.sh reste separe du service de config projet. Il ne connait pas
les organisations ni Prisma. Il transforme un identifiant skills.sh en snapshot
valide. Le service de config projet reste responsable du multi-tenant, des
upserts et de la materialisation runtime.

## Modele de donnees

### Extension de `ProjectSkill`

Ajouter des champs optionnels :

| Champ | Type | Description |
|---|---|---|
| `sourceProvider` | `String?` | `skills.sh` pour les imports catalogue |
| `sourcePackage` | `String?` | `owner/repo`, ex. `vercel-labs/agent-skills` |
| `sourceSkillId` | `String?` | slug/skill id cote source |
| `sourceUrl` | `String?` | lien consultable cote skills.sh |
| `sourceHash` | `String?` | hash du snapshot telecharge |
| `sourceMetadata` | `Json?` | metadata non critique : installs, repo path |
| `importedAt` | `DateTime?` | date du dernier import catalogue |

Le champ existant `source` continue de porter l'intention fonctionnelle :
`manual`, `imported`, `synced`.

Le champ existant `name` reste le nom de commande et de dossier ecrit dans
`.claude/skills/<name>/`. Pour les imports skills.sh, il vient du `skillId` /
install name de skills.sh, pas d'un display name arbitraire. Le frontmatter
original reste dans `body`, afin que Claude Code voie les metadata upstream
exactes.

### Nouveau modele `ProjectSkillFile`

Stocker les fichiers annexes du skill.

| Champ | Type | Description |
|---|---|---|
| `id` | `String` | cuid |
| `projectSkillId` | `String` | relation vers `ProjectSkill` |
| `path` | `String` | chemin relatif dans le dossier du skill |
| `contentBytes` | `Bytes` | contenu exact du fichier |
| `contentHash` | `String` | sha256 du contenu |
| `createdAt` | `DateTime` | audit |
| `updatedAt` | `DateTime` | audit |

Contraintes :

- `@@unique([projectSkillId, path])`
- index sur `projectSkillId`
- cascade delete depuis `ProjectSkill`

`SKILL.md` reste stocke dans `ProjectSkill.body` pour conserver le modele
existant et faciliter la liste/preview. Les fichiers annexes excluent `SKILL.md`.

## API serveur

### `searchSkillsSh`

Input :

```ts
{ query: string }
```

Regles :

- query trimmee, longueur minimale 2, longueur maximale 80 ;
- timeout reseau court ;
- retourne une liste bornee de resultats.

Output :

```ts
{
  results: Array<{
    id: string;
    name: string;
    source: string;
    installs: number | null;
    url: string;
  }>
}
```

### `getSkillsShSkill`

Input :

```ts
{ source: string; skill: string }
```

Telecharge le snapshot, valide les fichiers, parse `SKILL.md`, puis retourne une
preview sans persister.

Output :

```ts
{
  name: string;
  description: string;
  bodyPreview: string;
  source: string;
  skill: string;
  sourceHash: string;
  files: Array<{ path: string; size: number; hash: string }>;
  url: string;
}
```

### `importSkillsShSkill`

Input :

```ts
{
  projectId: string;
  source: string;
  skill: string;
  replace?: boolean;
}
```

Regles :

- verification organisation active ;
- le projet doit appartenir a l'organisation ;
- si un skill du meme nom existe et `replace` est absent/faux, retourner une
  erreur de conflit actionnable ;
- si `replace` est vrai, remplacer `body`, description, provenance et fichiers ;
- l'upsert du skill et de ses fichiers se fait dans une transaction unique ;
- refresh de `getProjectAgentConfig(projectId)`.

## Validation et securite

L'import d'un skill est un acte de confiance. La v1 applique des garde-fous
stricts et visibles :

- seuls les endpoints skills.sh sont appeles en import catalogue ;
- aucun script du skill n'est execute au moment de l'import ;
- chemins relatifs uniquement ;
- rejet des chemins absolus, `..`, segments vides, backslashes et octets nuls ;
- `SKILL.md` obligatoire ;
- frontmatter `name` et `description` obligatoires apres normalisation ;
- nom final valide selon les regles dotWeaver ;
- limites serveur :
  - 100 fichiers maximum par skill ;
  - 5 MB maximum au total ;
  - 1 MB maximum par fichier ;
  - chemin maximum 240 caracteres.
- les erreurs externes sont mappees en messages utilisateur simples ;
- les logs serveur ne contiennent jamais le contenu complet de fichiers tiers.

Le preview affiche toujours la source et le lien externe. Si skills.sh expose des
badges d'audit dans une API stable, l'UI pourra les afficher ; la v1 ne depend
pas de ces badges pour fonctionner.

## Materialisation au run

`buildRunAgentConfig` inclut les fichiers annexes des skills actives :

```ts
skills: Array<{
  name: string;
  body: string;
  files: Array<{ path: string; contentBytes: Uint8Array }>;
}>
```

`materializeRunAgentConfig` ecrit :

- `.claude/skills/<name>/SKILL.md`
- `.claude/skills/<name>/<file.path>` pour chaque fichier annexe

Tous les chemins generes sont ajoutes a `protectGeneratedAgentConfigFiles` afin
de ne pas polluer la surface de commit du run.

Le snapshot du run peut rester compact en v1 :

```ts
skills: Array<{
  id: string;
  name: string;
  sourceProvider?: string;
  sourcePackage?: string;
  sourceSkillId?: string;
  sourceHash?: string;
}>
```

## UX details

### Placement

Dans `AgentConfigPanel`, onglet `Skills` :

- liste actuelle des skills ;
- bouton `Browse skills.sh` ;
- formulaire manuel existant conserve sous la liste ou dans une section
  secondaire.

### Resultats de recherche

Chaque resultat affiche :

- nom ;
- source package ;
- installs ;
- etat si deja ajoute au projet ;
- bouton `Preview` ou `Add`.

### Preview

La preview peut etre une modale ou un panneau inline. Elle affiche :

- `name` et `description` ;
- source et lien ;
- hash ;
- fichiers annexes ;
- extrait du `SKILL.md` ;
- CTA `Add to project` ou `Replace project skill`.

### Conflits

Si un skill existe deja :

- meme source + meme hash : action desactivee avec `Already added` ;
- meme nom + hash/source different : demander confirmation `Replace`;
- skill manuel du meme nom : confirmation explicite indiquant que le skill
  manuel sera remplace par un import skills.sh.

## Gestion des erreurs

| Cas | Reponse |
|---|---|
| Query trop courte | pas d'appel reseau, aide UI |
| skills.sh indisponible | message `skills.sh is unavailable` |
| Aucun resultat | etat vide avec suggestion de termes |
| Snapshot introuvable | erreur actionnable, lien externe |
| `SKILL.md` invalide | rejet avec raison courte |
| Fichier dangereux | rejet du skill entier |
| Limite taille/fichiers depassee | rejet avec limite affichee |
| Conflit de nom | erreur de conflit + option replace |
| Projet hors org | 404/Project not found |

## Tests

### Unitaires

- `skills-sh-service.test.ts`
  - construit l'URL de recherche ;
  - filtre/borne les resultats ;
  - telecharge un snapshot ;
  - parse `SKILL.md` ;
  - rejette les chemins dangereux ;
  - rejette les snapshots sans `SKILL.md` ;
  - applique les limites taille/fichiers.
- `project-agent-config-service.test.ts`
  - upsert import avec provenance ;
  - remplace un skill existant avec `replace`;
  - conserve un conflit si `replace` est faux ;
  - materialise `SKILL.md` + fichiers annexes ;
  - protege tous les fichiers generes via git exclude.
- Schemas remote
  - validation des inputs search/preview/import.

### Integration legere

- remote functions mockant `fetch` skills.sh et Prisma ;
- verification du refresh `getProjectAgentConfig`.

### UI

- rendu de l'etat vide ;
- recherche avec debounce ;
- preview ;
- bouton `Already added` ;
- flow conflit `Replace`.

## Hors perimetre v1

- Executer `npx skills add` depuis dotWeaver.
- Installer des skills globalement sur la machine de l'utilisateur.
- Publier des skills vers skills.sh.
- Auto-update ou detection periodique des nouvelles versions.
- Supporter des registries autres que skills.sh.
- Importer depuis une URL GitHub arbitraire hors catalogue.
- Executer ou valider les scripts embarques.
- UI avancee de review de diff entre deux versions d'un skill.

## Plan de rollout

1. Ajouter le modele de donnees et migration.
2. Ajouter le service skills.sh avec tests de validation.
3. Ajouter les remote functions search/preview/import.
4. Etendre la materialisation runtime aux fichiers annexes.
5. Ajouter l'UI catalogue dans l'onglet Skills.
6. Verifier un import reel avec un skill simple et un run Claude Code.
