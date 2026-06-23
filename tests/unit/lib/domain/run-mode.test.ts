import { describe, expect, it } from 'vitest';
import {
	CDC_SKILL_NAME,
	RUN_MODE,
	buildEffectiveRunPrompt,
	isRunMode
} from '../../../../src/lib/domain/run-mode';

describe('run-mode domain', () => {
	it('exposes stable run mode constants', () => {
		expect(RUN_MODE.AGENT).toBe('agent');
		expect(RUN_MODE.CDC).toBe('cdc');
		expect(CDC_SKILL_NAME).toBe('cahier-des-charges');
		expect(isRunMode('agent')).toBe(true);
		expect(isRunMode('cdc')).toBe(true);
		expect(isRunMode('other')).toBe(false);
	});

	it('leaves normal agent prompts untouched', () => {
		expect(buildEffectiveRunPrompt('agent', 'Build the login screen')).toBe(
			'Build the login screen'
		);
	});

	it('wraps fresh cdc prompts with the dotWeaver contract', () => {
		const prompt = buildEffectiveRunPrompt('cdc', 'Je veux cadrer un CRM');

		expect(prompt).toContain('run dotWeaver de type Cahier des charges');
		expect(prompt).toContain('Utilise le skill cahier-des-charges');
		expect(prompt).toContain('<!-- dotweaver:cdc:start -->');
		expect(prompt).toContain('<!-- dotweaver:cdc:end -->');
		expect(prompt).toContain('Je veux cadrer un CRM');
	});
});
