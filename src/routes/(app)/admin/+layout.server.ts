import { admin } from '$lib/server/admin';
import { createLayoutLoad } from 'sveltekit-admin';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = createLayoutLoad(admin);
