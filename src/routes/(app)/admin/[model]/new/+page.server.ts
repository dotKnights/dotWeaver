import { admin } from '$lib/server/admin';
import { createModelNewLoad, createModelNewAction } from 'sveltekit-admin';
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = createModelNewLoad(admin);

export const actions: Actions = {
  default: async (event) => {
    const result = await createModelNewAction(admin)(event);
    if (result.success) {
      throw redirect(303, `/admin/${event.params.model}`);
    }
    return result;
  }
};
