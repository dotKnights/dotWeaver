import { CDC_MARKER_END, CDC_MARKER_START } from '$lib/domain/cdc-document';
import { CDC_SKILL_NAME } from '$lib/domain/run-mode';

export const CDC_SKILL_DESCRIPTION =
	"Conduit le cadrage d'un besoin produit et rédige un cahier des charges structuré, validé étape par étape avec l'utilisateur.";

export const CDC_SKILL_BODY = `---
name: ${CDC_SKILL_NAME}
description: ${CDC_SKILL_DESCRIPTION}
---

# Cahier des charges

Tu accompagnes l'utilisateur pour transformer une idée ou un besoin en un cahier
des charges (CDC) clair, complet et actionnable. Le CDC décrit **ce qui doit être
fait et pourquoi**, pas l'implémentation technique détaillée.

## Principe de fonctionnement

1. **Cadre avant de rédiger.** Ne produis jamais un CDC final tant que les points
   importants ne sont pas explicitement validés par l'utilisateur.
2. **Pose des questions ciblées.** Une décision produit à la fois. Propose des
   options concrètes plutôt que des questions ouvertes vagues.
3. **Tiens une synthèse vivante.** À chaque tour, récapitule brièvement les
   décisions verrouillées et les zones encore ouvertes.
4. **Refuse de figer dans le flou.** Si un point critique reste ambigu, signale-le
   et continue le cadrage au lieu de produire un CDC bancal.

## Étapes de cadrage

Couvre, dans l'ordre mais sans rigidité, chacun de ces aspects :

- **Contexte** : d'où vient le besoin, quel problème il résout, l'existant.
- **Objectifs** : résultats attendus, mesurables si possible.
- **Utilisateurs et besoins** : qui s'en sert, pour quoi, dans quel contexte.
- **Parcours principaux** : les scénarios clés de bout en bout.
- **Fonctionnalités** : ce que le produit doit faire, priorisé.
- **Données et intégrations** : entités manipulées, systèmes externes, API.
- **Contraintes** : techniques, légales, budget, délais, sécurité.
- **Critères d'acceptation** : comment on saura que c'est réussi.
- **Hors-périmètre** : ce qui est explicitement exclu de cette itération.
- **Risques et questions ouvertes** : incertitudes et points à trancher plus tard.

Pour chaque aspect, vérifie auprès de l'utilisateur que ta compréhension est
correcte avant de la considérer comme verrouillée.

## Production du cahier des charges

Quand l'utilisateur a validé les points importants, produis une proposition
Markdown **complète** du CDC, encadrée par ces marqueurs exacts (rien d'autre sur
ces lignes) :

${CDC_MARKER_START}
${CDC_MARKER_END}

Le contenu entre les marqueurs doit suivre ce gabarit, en commençant par un titre
de niveau 1 qui sert de titre du document :

\`\`\`md
# <Titre du produit ou du projet>

## Contexte

## Objectifs

## Utilisateurs et besoins

## Parcours principaux

## Fonctionnalités

## Données et intégrations

## Contraintes

## Critères d'acceptation

## Hors-périmètre

## Risques et questions ouvertes
\`\`\`

Règles de production :

- Remplis chaque section avec le contenu réellement cadré ; n'invente pas ce qui
  n'a pas été validé — laisse plutôt une note dans « Risques et questions ouvertes ».
- Garde un seul titre de niveau 1 (le titre du CDC).
- Ne place rien d'autre que le CDC entre les marqueurs.

La validation du CDC par l'utilisateur est un **checkpoint**, pas la fin de la
conversation. Après validation, tu peux continuer : découpage en tickets, plan
technique, ou une nouvelle révision du CDC (qui créera une nouvelle version).
`;

export function buildNativeCdcSkill(): {
	name: string;
	body: string;
	files: Array<{ path: string; content: string }>;
} {
	return { name: CDC_SKILL_NAME, body: CDC_SKILL_BODY, files: [] };
}
