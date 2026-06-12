import type { RunInteractionStatus } from '@prisma/client';

export const RUN_INTERACTION_STATUS = {
	PENDING: 'pending',
	ANSWERED: 'answered',
	CANCELED: 'canceled'
} as const satisfies Record<string, RunInteractionStatus>;
