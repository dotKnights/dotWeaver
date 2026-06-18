# Mode de run Cahier des charges -- Design

**Date** : 2026-06-18
**Statut** : Valide en brainstorming, en attente de relecture
**Perimetre** : mode de run CDC, skill dedie, validation explicite et artefact Markdown plateforme

## Objectif

Permettre a un utilisateur de lancer une run orientee cahier des charges sur un
projet dotWeaver. La run sert de fil de cadrage : l'agent clarifie le besoin,
utilise un skill CDC dedie, obtient l'accord utilisateur sur les points
importants, puis produit une proposition Markdown. L'utilisateur valide ensuite
explicitement cette proposition comme CDC final.

Le CDC valide devient un artefact natif dotWeaver, rattache au projet et a la
run, sans devoir etre commite dans le depot GitHub ni passer par le flux
diff/PR. La run reste continuable apres validation afin de poursuivre le travail
sur la meme conversation.

## Decisions cadrees

| Sujet | Decision |
| --- | --- |
| Mode produit | Nouveau mode de run `cdc` |
| Attachement | CDC rattache a un projet et a la run qui l'a produit |
| Source methode | Skill CDC dedie, active par instruction de debut de run |
| Prompt | DotWeaver ajoute un preprompt CDC au prompt utilisateur |
| Finalisation | Validation explicite utilisateur, jamais auto-publication silencieuse |
| Stockage | Artefact Markdown en base dotWeaver |
| Depot Git | Aucune ecriture requise dans le repo pour valider le CDC |
| Continuation | La run reste en `awaiting_review` et le composer existant continue de fonctionner |
| Versions | Plusieurs CDC valides possibles ; version incrementale par projet |

## Flux utilisateur

1. L'utilisateur ouvre un projet et choisit le mode de run `Cahier des charges`.
2. Il decrit l'idee, le produit ou le contexte a cadrer.
3. DotWeaver cree une run `cdc` avec la config agent projet active par defaut.
4. Au lancement, DotWeaver ajoute une instruction CDC au debut du prompt.
5. L'agent utilise le skill CDC pour cadrer le besoin, poser les questions
   utiles et verrouiller les decisions.
6. Quand l'utilisateur a valide les points importants, l'agent produit une
   proposition Markdown de CDC entre marqueurs stables.
7. La page de run detecte cette proposition et affiche `Valider comme CDC`.
8. L'utilisateur valide. DotWeaver cree un `CdcDocument` rattache au projet et a
   la run.
9. La run reste consultable et continuable. L'utilisateur peut demander la suite
   dans le composer existant, par exemple un decoupage en tickets, un plan
   technique ou une nouvelle revision du CDC.

## Contrat agent

Le mode `cdc` ne remplace pas le comportement agent existant. Il ajoute un cadre
explicite au debut de la run.

Preprompt conceptuel :

```text
Tu es dans une run dotWeaver de type Cahier des charges.
Utilise le skill cahier-des-charges pour conduire le cadrage.
Clarifie les objectifs, utilisateurs, parcours, contraintes, donnees,
integrations, risques, criteres d'acceptation et hors-perimetre.
Pose les questions necessaires jusqu'a obtenir un accord explicite.
Quand tous les aspects importants sont stabilises, produis une proposition
Markdown complete de CDC entre les marqueurs dotWeaver fournis.
La validation du CDC par l'utilisateur est un checkpoint, pas la fin obligatoire
de la run. Apres validation, tu peux continuer la conversation sur demande.
```

La version exacte du preprompt doit rester courte. Le detail methodologique vit
dans le skill CDC afin que l'utilisateur puisse l'ameliorer sans modifier la
logique de run.

## Skill CDC

Ajouter un skill projet ou systeme appele par exemple `cahier-des-charges`.

Responsabilites du skill :

- definir les etapes de cadrage ;
- encourager les questions structurees quand une decision produit doit etre
  verrouillee ;
- maintenir une synthese des decisions et zones ouvertes ;
- refuser de produire un CDC final si des points critiques restent ambigus ;
- fournir le gabarit Markdown final ;
- produire le Markdown final entre marqueurs stables.

Gabarit minimal attendu :

```md
# Cahier des charges

## Contexte
## Objectifs
## Utilisateurs et besoins
## Parcours principaux
## Fonctionnalites
## Donnees et integrations
## Contraintes
## Criteres d'acceptation
## Hors perimetre
## Risques et questions ouvertes
```

Le skill peut etre livre comme skill natif dotWeaver plus tard. En v1, le mode
de run doit pouvoir fonctionner si le skill existe dans la config agent projet ;
sinon DotWeaver remonte une erreur claire au lancement.

## Donnees

### `Run`

Ajouter un champ de mode :

```prisma
enum RunMode {
  agent
  cdc
}

model Run {
  mode RunMode @default(agent)
}
```

Les runs existantes restent `agent`. Le champ sert a :

- appliquer le preprompt CDC au lancement ;
- afficher les actions CDC dans l'UI ;
- filtrer/identifier les runs CDC dans l'historique ;
- proteger les commandes de validation CDC.

### `CdcDocument`

Nouveau modele :

```prisma
model CdcDocument {
  id             String   @id @default(cuid())
  organizationId String
  projectId      String
  runId          String
  createdById    String
  title          String
  markdown       String
  version        Int
  sourceEventSeq Int?
  createdAt      DateTime @default(now())

  project Project @relation(fields: [projectId, organizationId], references: [id, organizationId], onDelete: Cascade)
  run     Run     @relation(fields: [runId], references: [id], onDelete: Cascade)
  createdBy User  @relation(fields: [createdById], references: [id], onDelete: Cascade)

  @@unique([projectId, version])
  @@unique([runId, sourceEventSeq])
  @@index([organizationId, projectId])
  @@index([runId])
}
```

`version` est incrementee par projet. Si une meme run produit une nouvelle
proposition validee apres continuation, elle cree une nouvelle version. Les
anciennes versions restent consultables.

`sourceEventSeq` pointe vers l'event assistant qui contient le bloc valide si
l'extraction peut l'identifier. Ce champ sert a l'audit et n'est pas critique
pour le rendu.

Si le meme bloc est valide deux fois, le service retourne le document deja cree
pour ce `runId` et ce `sourceEventSeq`. Une nouvelle version n'est creee que si
la run produit un nouveau bloc CDC complet dans un event ulterieur.

## Detection de proposition CDC

Pour la v1, utiliser une convention de marqueurs explicites dans les messages
assistant :

```md
<!-- dotweaver:cdc:start -->
# Cahier des charges ...
...
<!-- dotweaver:cdc:end -->
```

La page de run extrait le dernier bloc complet depuis les events de la run. Si
aucun bloc complet n'est present, le bouton de validation n'apparait pas.

Regles :

- ignorer les blocs sans marqueur de fin ;
- utiliser le dernier bloc complet ;
- retirer les marqueurs avant stockage ;
- refuser un Markdown vide ;
- limiter la taille maximale stockable ;
- deriver `title` du premier H1, sinon utiliser un titre par defaut.

Cette approche est volontairement simple. Une future version pourra remplacer
l'extraction par un outil MCP `SubmitCdcDraft`, mais les marqueurs suffisent pour
un premier workflow fiable et lisible.

## Commandes serveur

Ajouter un service dedie, par exemple `src/lib/server/cdc-documents-service.ts`.

Responsabilites :

- verifier que le projet et la run appartiennent a l'organisation active ;
- verifier que la run est en mode `cdc` ;
- verifier que la run est dans un etat validable, principalement
  `awaiting_review` ;
- extraire le Markdown propose depuis les events de la run ;
- calculer la prochaine version du projet dans une transaction ;
- creer le `CdcDocument` ;
- lister les CDC d'un projet ;
- recuperer le detail d'un CDC.

Remote functions proposees :

- `listCdcDocuments(projectId)`
- `getCdcDocument(id)`
- `validateRunCdc({ runId })`

`validateRunCdc` lit le dernier bloc CDC complet dans les events de la run,
cree le document, refresh `getRun(runId)` et `listCdcDocuments(projectId)`.

## UI

### Page projet

Dans le formulaire de lancement de run :

- ajouter un controle de mode `Agent` / `Cahier des charges` ;
- conserver branche, modele et config agent projet ;
- adapter le placeholder du prompt quand le mode CDC est selectionne ;
- indiquer clairement si le skill CDC requis est absent.

Dans la page projet, ajouter une section compacte `Cahiers des charges` listant
les versions creees pour le projet.

### Page run

Pour une run `cdc` :

- afficher le mode dans les metadonnees ;
- detecter la derniere proposition CDC complete ;
- afficher une preview Markdown de la proposition ;
- afficher `Valider comme CDC` en `awaiting_review` ;
- apres validation, afficher un lien vers le CDC cree ;
- garder le composer de reprise existant disponible.

La validation du CDC ne pousse pas la branche, ne cree pas de PR et ne nettoie
pas le checkout. Elle n'appelle pas `approveRun`. C'est un checkpoint documentaire
independant du flux Git.

### Page CDC

Une page simple peut afficher :

- titre ;
- version ;
- projet et run source ;
- date de validation ;
- rendu Markdown ;
- lien de retour vers la run.

## Interaction avec la continuation de run

Le comportement existant de `replyToRun` est conserve. Apres validation du CDC :

1. la run reste en `awaiting_review` ;
2. l'utilisateur peut envoyer un message via le composer ;
3. `replyToRun` remet la meme run en queue et reprend la session ;
4. l'agent peut produire une nouvelle proposition CDC ou poursuivre vers un
   autre travail ;
5. si une nouvelle proposition est validee, DotWeaver cree une nouvelle version
   de `CdcDocument`.

Le CDC valide est donc une photographie de l'accord a un instant donne, pas une
fin de conversation.

## Gestion d'erreurs

| Cas | Comportement |
| --- | --- |
| Skill CDC absent | Refus au lancement avec message clair |
| Run non CDC | `validateRunCdc` renvoie 400 |
| Run pas en `awaiting_review` | validation refusee pour eviter un draft incomplet |
| Aucun bloc marque | bouton absent cote UI, 400 cote serveur |
| Markdown trop volumineux | validation refusee avec limite explicite |
| Concurrence double validation | le meme `sourceEventSeq` retourne le document existant ; un nouveau bloc cree une nouvelle version |
| Projet/run hors org | 404 ou 403 selon pattern existant |

## Tests

- `runs` schema/service :
  - creation d'une run `agent` par defaut ;
  - creation d'une run `cdc` avec preprompt applique ;
  - refus si skill CDC requis absent.
- extraction CDC :
  - dernier bloc complet retenu ;
  - bloc incomplet ignore ;
  - marqueurs retires avant stockage ;
  - H1 utilise comme titre ;
  - Markdown vide ou trop gros refuse.
- service CDC :
  - creation version 1 puis version 2 sur le meme projet ;
  - refus run non CDC ;
  - refus run hors organisation ;
  - validation ne modifie pas le statut de run.
- UI :
  - mode CDC selectionnable au lancement ;
  - preview et bouton visibles seulement quand une proposition existe ;
  - apres validation, le composer reste disponible.

## Hors perimetre v1

- Formatage riche du CDC.
- Export DOCX/PDF.
- Edition manuelle du CDC dans dotWeaver apres validation.
- Synchronisation automatique vers le repo.
- Statut `draft` persiste separement des events.
- Comparaison visuelle entre versions.
- Generation automatique de tickets depuis le CDC.

## Decoupage indicatif

1. Ajouter `RunMode`, `CdcDocument` et les migrations.
2. Ajouter schemas, service CDC et extraction de bloc marque.
3. Etendre `startRun` pour accepter `mode` et appliquer le preprompt CDC.
4. Verifier la presence du skill CDC pour les runs `cdc`.
5. Ajouter les remote functions CDC.
6. Ajouter le selecteur de mode et la liste CDC sur la page projet.
7. Ajouter preview + validation CDC sur la page run.
8. Ajouter la page detail CDC.
9. Couvrir les tests unitaires et UI pertinents.
