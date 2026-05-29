import { z } from 'zod';

export const createTeamSchema = z.object({
	name: z.string().min(2, 'Team name must be at least 2 characters')
});

export const inviteSchema = z.object({
	email: z.email('Invalid email address'),
	role: z.enum(['admin', 'member'])
});

export type CreateTeamSchema = typeof createTeamSchema;
export type InviteSchema = typeof inviteSchema;
