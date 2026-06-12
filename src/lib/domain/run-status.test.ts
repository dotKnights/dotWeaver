import { describe, expect, it } from 'vitest';
import {
	RUN_STATUS,
	RUN_STATUS_GROUPS,
	canTransition,
	isFinalRunStatus,
	isRunStatusInGroup,
	isWorkerDoneRunStatus
} from './run-status';

describe('run-status domain', () => {
	it('exposes named constants for run statuses', () => {
		expect(RUN_STATUS.AWAITING_REVIEW).toBe('awaiting_review');
		expect(RUN_STATUS.AWAITING_INPUT).toBe('awaiting_input');
	});

	it('separates worker-done statuses from final business statuses', () => {
		expect(isWorkerDoneRunStatus(RUN_STATUS.AWAITING_REVIEW)).toBe(true);
		expect(isFinalRunStatus(RUN_STATUS.AWAITING_REVIEW)).toBe(false);
		expect(isFinalRunStatus(RUN_STATUS.COMPLETED)).toBe(true);
	});

	it('keeps cancelable and orphanable groups explicit', () => {
		expect(isRunStatusInGroup(RUN_STATUS.QUEUED, RUN_STATUS_GROUPS.CANCELABLE)).toBe(true);
		expect(isRunStatusInGroup(RUN_STATUS.QUEUED, RUN_STATUS_GROUPS.ORPHANABLE)).toBe(false);
		expect(isRunStatusInGroup(RUN_STATUS.PUSHING, RUN_STATUS_GROUPS.ORPHANABLE)).toBe(true);
	});

	it('owns the allowed transition graph', () => {
		expect(canTransition(RUN_STATUS.RUNNING, RUN_STATUS.AWAITING_INPUT)).toBe(true);
		expect(canTransition(RUN_STATUS.AWAITING_INPUT, RUN_STATUS.RUNNING)).toBe(true);
		expect(canTransition(RUN_STATUS.QUEUED, RUN_STATUS.COMPLETED)).toBe(false);
	});
});
