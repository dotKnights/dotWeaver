import { z } from 'zod';
import { permissionPresets } from '$lib/authz/permissions';

const permissionPresetKeys = Object.keys(permissionPresets) as [
	keyof typeof permissionPresets,
	...(keyof typeof permissionPresets)[]
];

export const createClientOrganizationSchema = z.object({
	name: z.string().min(2, 'Client organization name must be at least 2 characters')
});

export const clientMemberRoleSchema = z.enum(['admin', 'member']);

export const inviteClientMemberSchema = z.object({
	clientOrganizationId: z.string().min(1),
	email: z.email('Invalid email address'),
	role: clientMemberRoleSchema.default('member')
});

export const accessGrantSubjectSchema = z.object({
	subjectType: z.enum(['client_organization', 'client_member']),
	subjectId: z.string().min(1)
});

export const permissionPresetSchema = z.enum(permissionPresetKeys);

export const upsertProjectAccessGrantSchema = accessGrantSubjectSchema.extend({
	projectId: z.string().min(1),
	preset: permissionPresetSchema
});

export const removeProjectAccessGrantSchema = accessGrantSubjectSchema.extend({
	projectId: z.string().min(1)
});

export const removeClientMemberSchema = z.object({
	clientOrganizationId: z.string().min(1),
	clientMemberId: z.string().min(1)
});

export const deleteClientOrganizationSchema = z.object({
	clientOrganizationId: z.string().min(1)
});
