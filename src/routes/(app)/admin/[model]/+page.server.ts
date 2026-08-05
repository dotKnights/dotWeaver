import { admin } from '$lib/server/admin';
import { createModelListLoad, createModelDeleteAction } from 'sveltekit-admin';
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = createModelListLoad(admin);

export const actions: Actions = {
  delete: async (event) => {
    const result = await createModelDeleteAction(admin)(event);
    if (result.success) {
      throw redirect(303, `/admin/${event.params.model}`);
    }
    return result;
  }
};
