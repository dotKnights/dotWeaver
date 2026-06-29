import { z } from 'zod';

export const importProjectSchema = z.object({
	owner: z.string().min(1, 'Owner is required'),
	name: z.string().min(1, 'Repository name is required')
});
