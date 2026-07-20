import { describe, expect, expectTypeOf, it } from 'vitest';
import {
	assertPermissions,
	createPermissionRegistry,
	definePermissionModule,
	isPermission,
	permissionModules,
	permissionPresets,
	permissionRegistry,
	projectPermissions,
	runPermissions
} from '$lib/authz/permissions';
import type {
	Permission,
	PermissionKey,
	PermissionMetadata,
	RegisteredPermission
} from '$lib/authz/permissions';
import { accessGrantResourceTypes, projectResource } from '$lib/authz/resources';

describe('authz resources', () => {
	it('defines project access grant resources', () => {
		expect(accessGrantResourceTypes).toEqual(['project']);
		expect(projectResource('project_1')).toEqual({ type: 'project', id: 'project_1' });
	});
});

describe('permission registry', () => {
	it('keeps the initial permission order stable', () => {
		expect(permissionRegistry.permissions.map((permission) => permission.key)).toEqual([
			'project.view',
			'project.manage_access',
			'project.config.view',
			'project.config.manage',
			'run.view',
			'run.create',
			'run.reply',
			'run.diff.view',
			'run.approve'
		]);
	});

	it('centralizes registered permission modules', () => {
		expect(permissionModules[0]).toBe(projectPermissions);
		expect(permissionModules[1]).toBe(runPermissions);
		expect(permissionRegistry.permissions).toEqual([
			...permissionModules[0],
			...permissionModules[1]
		]);
	});

	it('keeps permission string and metadata types distinct', () => {
		expectTypeOf<Permission>().toEqualTypeOf<PermissionKey>();
		expectTypeOf<RegisteredPermission>().toMatchTypeOf<PermissionMetadata>();
		expectTypeOf<RegisteredPermission['key']>().toEqualTypeOf<PermissionKey>();
		expect(isPermission('project.view')).toBe(true);
	});

	it('defines project and run permission modules', () => {
		expect(projectPermissions.map((permission) => permission.key)).toEqual([
			'project.view',
			'project.manage_access',
			'project.config.view',
			'project.config.manage'
		]);
		expect(runPermissions.map((permission) => permission.key)).toEqual([
			'run.view',
			'run.create',
			'run.reply',
			'run.diff.view',
			'run.approve'
		]);
		expect(projectPermissions[0]).toEqual({
			key: 'project.view',
			resource: 'project',
			action: 'view',
			label: 'View project',
			description: 'Can open and read project details.',
			category: 'Project'
		});
	});

	it('builds permission keys from module resources and preserves metadata', () => {
		const permissions = definePermissionModule({
			resource: 'workspace',
			permissions: {
				view: {
					label: 'View workspace',
					description: 'Can inspect workspace details.',
					category: 'Workspace'
				},
				archive: {
					label: 'Archive workspace'
				}
			}
		});

		expect(permissions).toEqual([
			{
				key: 'workspace.view',
				resource: 'workspace',
				action: 'view',
				label: 'View workspace',
				description: 'Can inspect workspace details.',
				category: 'Workspace'
			},
			{
				key: 'workspace.archive',
				resource: 'workspace',
				action: 'archive',
				label: 'Archive workspace'
			}
		]);
	});

	it('exposes UX permission presets', () => {
		expect(Object.keys(permissionPresets)).toEqual([
			'project_access',
			'follow_up',
			'reviewer',
			'operator',
			'project_admin'
		]);
		expect(permissionPresets.project_access.permissions).toEqual(['project.view']);
		expect(permissionPresets.follow_up.permissions).toEqual(['project.view', 'run.view']);
		expect(permissionPresets.reviewer.permissions).toEqual([
			'project.view',
			'run.view',
			'run.diff.view',
			'run.reply'
		]);
		expect(permissionPresets.operator.permissions).toEqual([
			'project.view',
			'run.view',
			'run.create',
			'run.reply',
			'run.diff.view'
		]);
		expect(permissionPresets.project_admin.permissions).toEqual([
			'project.view',
			'project.manage_access',
			'project.config.view',
			'project.config.manage',
			'run.view',
			'run.create',
			'run.reply',
			'run.diff.view',
			'run.approve'
		]);
	});

	it('rejects duplicate permission keys', () => {
		const duplicate = definePermissionModule({
			resource: 'project',
			permissions: {
				view: {
					label: 'Duplicate view'
				}
			}
		});

		expect(() => createPermissionRegistry([projectPermissions, duplicate])).toThrow(
			'Duplicate permission: project.view'
		);
	});

	it('rejects presets that reference unknown permissions', () => {
		expect(() =>
			createPermissionRegistry([projectPermissions], {
				owner: {
					label: 'Owner',
					permissions: ['project.view', 'run.view']
				}
			})
		).toThrow('Unknown permission in preset owner: run.view');
	});

	it('checks and asserts permission values', () => {
		expect(isPermission('run.reply')).toBe(true);
		expect(isPermission('run.cancel')).toBe(false);
		expect(assertPermissions(['project.view', 'run.view'])).toEqual(['project.view', 'run.view']);
		expect(() => assertPermissions(['project.view', 'run.cancel'])).toThrow(
			'Unknown permission: run.cancel'
		);
	});
});
