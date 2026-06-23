import z from 'zod';

export const cdcDocumentIdSchema = z.string().min(1, 'CDC document is required');

export const validateRunCdcSchema = z.object({
	runId: z.string().min(1, 'Run is required')
});

export type ValidateRunCdcSchema = typeof validateRunCdcSchema;
