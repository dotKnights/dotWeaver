import { describe, it, expect } from 'vitest';
import { ORPHAN_STATUSES } from '$lib/server/run-recovery';

describe('ORPHAN_STATUSES', () => {
	it('covers active non-queued statuses, excludes queued + terminal', () => {
		expect([...ORPHAN_STATUSES].sort()).toEqual([
			'awaiting_input',
			'preparing',
			'pushing',
			'running'
		]);
		expect(ORPHAN_STATUSES).not.toContain('queued');
		expect(ORPHAN_STATUSES).not.toContain('completed');
	});
});
