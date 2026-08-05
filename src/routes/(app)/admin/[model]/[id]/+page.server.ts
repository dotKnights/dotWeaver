import { admin } from '$lib/server/admin';
import { createModelEditLoad, createModelEditAction } from 'sveltekit-admin';
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = createModelEditLoad(admin);

export const actions: Actions = {
  default: async (event) => {
    const result = await createModelEditAction(admin)(event);
    if (result.success) {
      throw redirect(303, `/admin/${event.params.model}`);
    }
    return result;
  }
};
