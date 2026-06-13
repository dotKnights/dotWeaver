import { z } from 'zod';

export const getMailThreadSchema = z.object({
	gmailThreadId: z
		.string()
		.trim()
		.min(1)
		.max(128)
		.regex(/^[a-zA-Z0-9_-]+$/)
});
