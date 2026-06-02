import type { RequestHandler } from './$types';
import { oAuthDiscoveryMetadata } from 'better-auth/plugins';
import { auth } from '$lib/server/auth';

export const GET: RequestHandler = ({ request }) => oAuthDiscoveryMetadata(auth)(request);
