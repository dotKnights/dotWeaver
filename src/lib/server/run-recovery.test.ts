import { describe, it, expect } from 'vitest';
import { ORPHAN_STATUSES } from './run-recovery';

describe('ORPHAN_STATUSES', () => {
	it('covers active non-queued statuses, excludes queued + terminal', () => {
		expect([...ORPHAN_STATUSES].sort()).toEqual(['preparing', 'pushing', 'running']);
		expect(ORPHAN_STATUSES).not.toContain('queued');
		expect(ORPHAN_STATUSES).not.toContain('completed');
	});
});
