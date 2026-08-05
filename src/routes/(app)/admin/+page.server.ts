import { admin } from '$lib/server/admin';
import { createDashboardLoad } from 'sveltekit-admin';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = createDashboardLoad(admin);
