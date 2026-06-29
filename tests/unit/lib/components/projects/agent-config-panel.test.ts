import { describe, expect, it } from 'vitest';
import { envVarDisplayValue, skillSourceLabel } from '$lib/components/projects/agent-config-panel';

describe('agent config panel helpers', () => {
	it('labels skills by source provider', () => {
		expect(skillSourceLabel({ sourceProvider: 'skills.sh', description: 'From catalog' })).toBe(
			'skills.sh'
		);
		expect(skillSourceLabel({ sourceProvider: 'manual', description: 'Local skill' })).toBe(
			'Local skill'
		);
	});

	it('formats sensitive environment variable values', () => {
		expect(
			envVarDisplayValue({ id: 'env1', value: 'public', sensitive: false, enabled: true }, {})
		).toBe('public');
		expect(
			envVarDisplayValue({ id: 'env1', value: 'secret', sensitive: true, enabled: true }, {})
		).toBe('••••••');
		expect(
			envVarDisplayValue(
				{ id: 'env1', value: 'secret', sensitive: true, enabled: false },
				{ env1: 'revealed' }
			)
		).toBe('revealed · disabled');
	});
});
