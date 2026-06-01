import type { RunStatus } from '@prisma/client';

const TRANSITIONS: Record<RunStatus, RunStatus[]> = {
	queued: ['preparing', 'failed', 'canceled'],
	preparing: ['running', 'failed', 'canceled'],
	running: ['awaiting_review', 'failed', 'canceled', 'timed_out'],
	awaiting_review: ['pushing', 'completed', 'canceled'],
	pushing: ['completed', 'failed'],
	completed: [],
	failed: [],
	canceled: [],
	timed_out: []
};

export function canTransition(from: RunStatus, to: RunStatus): boolean {
	return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: RunStatus, to: RunStatus): void {
	if (!canTransition(from, to)) {
		throw new Error(`Invalid run transition ${from} -> ${to}`);
	}
}
