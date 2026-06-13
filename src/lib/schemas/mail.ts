import { z } from 'zod';

export const getMailThreadSchema = z.object({
	gmailThreadId: z.string().min(1)
});
