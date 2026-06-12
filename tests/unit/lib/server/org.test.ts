import { describe, it, expect } from 'vitest';
import { resolveActiveOrgId } from '$lib/server/org';

describe('resolveActiveOrgId', () => {
	it('returns the active org id when present', () => {
		expect(resolveActiveOrgId({ activeOrganizationId: 'org_1' })).toBe('org_1');
	});

	it('throws when no active org is selected', () => {
		expect(() => resolveActiveOrgId({ activeOrganizationId: null })).toThrow('No active team');
	});

	it('throws when session is null', () => {
		expect(() => resolveActiveOrgId(null)).toThrow('No active team');
	});
});
