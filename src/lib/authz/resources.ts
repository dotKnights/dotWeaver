export const accessGrantResourceTypes = ['project'] as const;

export type AccessGrantResourceType = (typeof accessGrantResourceTypes)[number];

export type AuthzResource = {
	type: AccessGrantResourceType;
	id: string;
};

export function projectResource(id: string): AuthzResource {
	return { type: 'project', id };
}
