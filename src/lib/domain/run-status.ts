import type { RunStatus } from '@prisma/client';

export const RUN_STATUS = {
	QUEUED: 'queued',
	PREPARING: 'preparing',
	RUNNING: 'running',
	AWAITING_INPUT: 'awaiting_input',
	AWAITING_REVIEW: 'awaiting_review',
	PUSHING: 'pushing',
	COMPLETED: 'completed',
	FAILED: 'failed',
	CANCELED: 'canceled',
	TIMED_OUT: 'timed_out'
} as const satisfies Record<string, RunStatus>;

export const RUN_STATUS_GROUPS = {
	CANCELABLE: [
		RUN_STATUS.QUEUED,
		RUN_STATUS.PREPARING,
		RUN_STATUS.RUNNING,
		RUN_STATUS.AWAITING_INPUT
	],
	STREAMABLE: [
		RUN_STATUS.QUEUED,
		RUN_STATUS.PREPARING,
		RUN_STATUS.RUNNING,
		RUN_STATUS.AWAITING_INPUT,
		RUN_STATUS.PUSHING
	],
	ORPHANABLE: [
		RUN_STATUS.PREPARING,
		RUN_STATUS.RUNNING,
		RUN_STATUS.AWAITING_INPUT,
		RUN_STATUS.PUSHING
	],
	WORKER_DONE: [
		RUN_STATUS.AWAITING_REVIEW,
		RUN_STATUS.COMPLETED,
		RUN_STATUS.FAILED,
		RUN_STATUS.CANCELED,
		RUN_STATUS.TIMED_OUT
	],
	FINAL: [RUN_STATUS.COMPLETED, RUN_STATUS.FAILED, RUN_STATUS.CANCELED, RUN_STATUS.TIMED_OUT],
	REVIEWABLE: [RUN_STATUS.AWAITING_REVIEW]
} as const satisfies Record<string, readonly RunStatus[]>;

const RUN_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
	[RUN_STATUS.QUEUED]: [
		RUN_STATUS.PREPARING,
		RUN_STATUS.RUNNING,
		RUN_STATUS.FAILED,
		RUN_STATUS.CANCELED
	],
	[RUN_STATUS.PREPARING]: [RUN_STATUS.RUNNING, RUN_STATUS.FAILED, RUN_STATUS.CANCELED],
	[RUN_STATUS.RUNNING]: [
		RUN_STATUS.AWAITING_INPUT,
		RUN_STATUS.AWAITING_REVIEW,
		RUN_STATUS.FAILED,
		RUN_STATUS.CANCELED,
		RUN_STATUS.TIMED_OUT
	],
	[RUN_STATUS.AWAITING_INPUT]: [
		RUN_STATUS.RUNNING,
		RUN_STATUS.FAILED,
		RUN_STATUS.CANCELED,
		RUN_STATUS.TIMED_OUT
	],
	[RUN_STATUS.AWAITING_REVIEW]: [
		RUN_STATUS.PUSHING,
		RUN_STATUS.COMPLETED,
		RUN_STATUS.CANCELED,
		RUN_STATUS.QUEUED
	],
	[RUN_STATUS.PUSHING]: [RUN_STATUS.COMPLETED, RUN_STATUS.FAILED],
	[RUN_STATUS.COMPLETED]: [],
	[RUN_STATUS.FAILED]: [],
	[RUN_STATUS.CANCELED]: [],
	[RUN_STATUS.TIMED_OUT]: []
};

export function isRunStatusInGroup(status: RunStatus, group: readonly RunStatus[]): boolean {
	return group.includes(status);
}

export function isWorkerDoneRunStatus(status: RunStatus): boolean {
	return isRunStatusInGroup(status, RUN_STATUS_GROUPS.WORKER_DONE);
}

export function isFinalRunStatus(status: RunStatus): boolean {
	return isRunStatusInGroup(status, RUN_STATUS_GROUPS.FINAL);
}

export function isCancelableRunStatus(status: RunStatus): boolean {
	return isRunStatusInGroup(status, RUN_STATUS_GROUPS.CANCELABLE);
}

export function isStreamableRunStatus(status: RunStatus): boolean {
	return isRunStatusInGroup(status, RUN_STATUS_GROUPS.STREAMABLE);
}

export function canTransition(from: RunStatus, to: RunStatus): boolean {
	return RUN_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: RunStatus, to: RunStatus): void {
	if (!canTransition(from, to)) {
		throw new Error(`Invalid run transition ${from} -> ${to}`);
	}
}
