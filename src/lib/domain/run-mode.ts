export const RUN_MODE = {
	AGENT: 'agent',
	CDC: 'cdc'
} as const;

export type RunMode = (typeof RUN_MODE)[keyof typeof RUN_MODE];

export const CDC_SKILL_NAME = 'cahier-des-charges';

export const CDC_RUN_PROMPT_PREFIX = `Tu es dans une run dotWeaver de type Cahier des charges.
Utilise le skill cahier-des-charges pour conduire le cadrage.
Clarifie les objectifs, utilisateurs, parcours, contraintes, donnees, integrations, risques, criteres d'acceptation et hors-perimetre.
Pose les questions necessaires jusqu'a obtenir un accord explicite.
Quand tous les aspects importants sont stabilises, produis une proposition Markdown complete de CDC entre ces marqueurs exacts :
<!-- dotweaver:cdc:start -->
<!-- dotweaver:cdc:end -->
La validation du CDC par l'utilisateur est un checkpoint, pas la fin obligatoire de la run. Apres validation, tu peux continuer la conversation sur demande.`;

export function isRunMode(value: unknown): value is RunMode {
	return value === RUN_MODE.AGENT || value === RUN_MODE.CDC;
}

export function buildEffectiveRunPrompt(mode: RunMode, prompt: string): string {
	if (mode !== RUN_MODE.CDC) return prompt;
	return `${CDC_RUN_PROMPT_PREFIX}\n\nPrompt utilisateur :\n${prompt}`;
}
