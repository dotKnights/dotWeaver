import { superValidate } from 'sveltekit-superforms'
import { zod4 as zod } from 'sveltekit-superforms/adapters'
import { loginSchema } from '$lib/schemas/auth'
import { redirect } from '@sveltejs/kit'
import type { PageServerLoad } from './$types'

export const load: PageServerLoad = async ({ locals }) => {
  if (locals.session) redirect(303, '/dashboard')
  return { form: await superValidate(zod(loginSchema)) }
}
