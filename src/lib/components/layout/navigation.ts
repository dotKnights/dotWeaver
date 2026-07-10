import { Cable, FolderKanban, LayoutDashboard, Mail, Users } from '@lucide/svelte';
import type { Component } from 'svelte';
import type { LucideProps } from '@lucide/svelte';

export type TeamOption = {
	id: string;
	name: string;
};

export type NavItem = {
	label: string;
	href: string;
	icon: Component<LucideProps>;
	requiresInternalTeam?: boolean;
};

export const navItems: NavItem[] = [
	{ label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
	{ label: 'Projects', href: '/projects', icon: FolderKanban },
	{ label: 'Teams', href: '/teams', icon: Users, requiresInternalTeam: true },
	{ label: 'Mail', href: '/mail', icon: Mail, requiresInternalTeam: true },
	{
		label: 'Connecteurs',
		href: '/settings/connectors',
		icon: Cable,
		requiresInternalTeam: true
	}
];

export function isNavItemActive(pathname: string, href: string) {
	return pathname === href || pathname.startsWith(`${href}/`);
}
