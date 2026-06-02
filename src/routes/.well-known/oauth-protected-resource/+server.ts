import type { RequestHandler } from './$types';
import { oAuthProtectedResourceMetadata } from 'better-auth/plugins';
import { auth } from '$lib/server/auth';

export const GET: RequestHandler = ({ request }) => oAuthProtectedResourceMetadata(auth)(request);
