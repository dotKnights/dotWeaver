export type PermissionMetadata = {
	label: string;
	description?: string;
	category?: string;
};

export type PermissionDefinitionWithKey<
	Resource extends string = string,
	Action extends string = string
> = PermissionMetadata & {
	key: `${Resource}.${Action}`;
	resource: Resource;
	action: Action;
};

export type PermissionDefinition<
	Resource extends string = string,
	Action extends string = string
> = PermissionDefinitionWithKey<Resource, Action>;

export type PermissionModule = readonly PermissionDefinitionWithKey[];

export type PermissionPreset<Permission extends string = string> = {
	label: string;
	permissions: readonly Permission[];
};

export type PermissionPresets<Permission extends string = string> = Record<
	string,
	PermissionPreset<Permission>
>;

export type PermissionRegistry<
	Definition extends PermissionDefinitionWithKey = PermissionDefinitionWithKey,
	Presets extends PermissionPresets<string> = PermissionPresets<Definition['key']>
> = {
	permissions: readonly Definition[];
	permissionKeys: ReadonlySet<Definition['key']>;
	presets: Presets;
};

type PermissionDefinitionsInput = Record<string, PermissionMetadata>;

export function definePermissionModule<
	const Resource extends string,
	const Definitions extends PermissionDefinitionsInput
>({
	resource,
	permissions
}: {
	resource: Resource;
	permissions: Definitions;
}): PermissionDefinitionWithKey<Resource, Extract<keyof Definitions, string>>[] {
	return Object.entries(permissions).map(([action, metadata]) => ({
		key: `${resource}.${action}` as `${Resource}.${Extract<keyof Definitions, string>}`,
		resource,
		action: action as Extract<keyof Definitions, string>,
		...metadata
	}));
}

export function createPermissionRegistry<
	const Modules extends readonly PermissionModule[],
	const Presets extends PermissionPresets<string> = Record<string, never>
>(modules: Modules, presets = {} as Presets): PermissionRegistry<Modules[number][number], Presets> {
	const permissionKeys = new Set<Modules[number][number]['key']>();
	const permissions = modules.flatMap((module) => module) as Modules[number][number][];

	for (const permission of permissions) {
		if (permissionKeys.has(permission.key)) {
			throw new Error(`Duplicate permission: ${permission.key}`);
		}

		permissionKeys.add(permission.key);
	}

	for (const [presetKey, preset] of Object.entries(presets)) {
		for (const permission of preset.permissions) {
			if (!permissionKeys.has(permission as Modules[number][number]['key'])) {
				throw new Error(`Unknown permission in preset ${presetKey}: ${permission}`);
			}
		}
	}

	return {
		permissions,
		permissionKeys,
		presets
	};
}

export const projectPermissions = definePermissionModule({
	resource: 'project',
	permissions: {
		view: {
			label: 'View project',
			description: 'Can open and read project details.',
			category: 'Project'
		},
		manage_access: {
			label: 'Manage project access',
			description: 'Can invite, remove, and update project access grants.',
			category: 'Project'
		},
		'config.view': {
			label: 'View project configuration',
			description: 'Can inspect project configuration and environment settings.',
			category: 'Project configuration'
		},
		'config.manage': {
			label: 'Manage project configuration',
			description: 'Can update project configuration and environment settings.',
			category: 'Project configuration'
		}
	}
});

export const runPermissions = definePermissionModule({
	resource: 'run',
	permissions: {
		view: {
			label: 'View runs',
			description: 'Can view run history, status, and outputs.',
			category: 'Runs'
		},
		create: {
			label: 'Create runs',
			description: 'Can start new runs for the project.',
			category: 'Runs'
		},
		reply: {
			label: 'Reply to runs',
			description: 'Can answer run questions and continue active runs.',
			category: 'Runs'
		},
		'diff.view': {
			label: 'View run diffs',
			description: 'Can inspect code changes produced by runs.',
			category: 'Run review'
		},
		approve: {
			label: 'Approve runs',
			description: 'Can approve run outputs for follow-up actions.',
			category: 'Run review'
		}
	}
});

export const permissionModules = [projectPermissions, runPermissions] as const;

export type RegisteredPermission = (typeof permissionModules)[number][number];
export type RegisteredPermissionMetadata = RegisteredPermission;
export type PermissionKey = RegisteredPermission['key'];
export type Permission = PermissionKey;

export const permissionPresets = {
	project_access: {
		label: 'Project access',
		permissions: ['project.view']
	},
	follow_up: {
		label: 'Follow-up',
		permissions: ['project.view', 'run.view']
	},
	reviewer: {
		label: 'Reviewer',
		permissions: ['project.view', 'run.view', 'run.diff.view', 'run.reply']
	},
	operator: {
		label: 'Operator',
		permissions: ['project.view', 'run.view', 'run.create', 'run.reply', 'run.diff.view']
	},
	project_admin: {
		label: 'Project admin',
		permissions: [
			'project.view',
			'project.manage_access',
			'project.config.view',
			'project.config.manage',
			'run.view',
			'run.create',
			'run.reply',
			'run.diff.view',
			'run.approve'
		]
	}
} as const satisfies PermissionPresets<PermissionKey>;

export const permissionRegistry = createPermissionRegistry(permissionModules, permissionPresets);

export type PermissionPresetKey = keyof typeof permissionPresets;

export function isPermission(permission: string): permission is PermissionKey {
	return permissionRegistry.permissionKeys.has(permission as PermissionKey);
}

export function assertPermissions(permissions: readonly string[]): PermissionKey[] {
	for (const permission of permissions) {
		if (!isPermission(permission)) {
			throw new Error(`Unknown permission: ${permission}`);
		}
	}

	return [...permissions] as PermissionKey[];
}
