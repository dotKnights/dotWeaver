import { describe, expect, it } from 'vitest';
import { RUN_INTERACTION_STATUS } from './run-interaction-status';

describe('run-interaction-status domain', () => {
	it('exposes named constants for run interaction statuses', () => {
		expect(RUN_INTERACTION_STATUS.PENDING).toBe('pending');
		expect(RUN_INTERACTION_STATUS.ANSWERED).toBe('answered');
		expect(RUN_INTERACTION_STATUS.CANCELED).toBe('canceled');
	});
});
